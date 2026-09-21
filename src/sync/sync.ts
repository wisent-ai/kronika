import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkDocumentation } from "../docs/checker.js";
import type {
  CompletionClient,
  DocumentationFinding,
} from "../docs/model/types.js";
import { writeDocumentation } from "../docs/writer.js";

export {
  SYNC_MANIFEST_FILE,
  SYNC_STATE_FILE,
} from "./shape.js";
export type {
  SyncDefaults,
  SyncDocument,
  SyncManifest,
  SyncOptions,
  SyncOutcome,
  SyncResult,
  SyncState,
} from "./shape.js";

import { SYNC_STATE_FILE } from "./shape.js";
import type {
  SyncDocument,
  SyncManifest,
  SyncOptions,
  SyncOutcome,
  SyncResult,
  SyncState,
  SyncStateEntry,
} from "./shape.js";

// `kronika sync` closes the loop the single-shot verbs leave open: `check`
// audits one change and `write` regenerates one document, but nothing
// remembered where documentation last agreed with the source. Sync carries
// that memory in the repository itself, so a scheduler can run it forever and
// each tick does only the work the evidence demands:
//
//   no state          -> record the baseline, touch nothing else. A first run
//                        that rewrote every document through a model would
//                        replace reviewed prose wholesale; sync maintains
//                        documents from the moment they enter the manifest.
//   nothing changed   -> advance nothing, call nothing.
//   sources changed   -> audit the exact Git range through Brama (`check`).
//                        A passing audit IS the update: the documentation
//                        already covers the change, and the state advances
//                        without churn — the checker's own contract is
//                        "never require churn merely because source changed".
//   audit blocks      -> regenerate the document through Brama (`write`),
//                        instructed with the audit's own findings, so the
//                        rewrite corrects named defects instead of freely
//                        re-authoring reviewed text.
//
// Both files live in the target repository and are meant to be committed:
// the manifest is the human's declaration of which documents are maintained
// from which evidence, and the state file is the auditable record of the
// last commit each document was reconciled against.
export { loadSyncManifest } from "./state.js";

import { changedPathsFor, git, loadSyncManifest, loadSyncState, rewriteInstruction } from "./state.js";


export const syncDocumentation = async (
  options: SyncOptions,
  client: CompletionClient,
): Promise<SyncResult> => {
  const repo = resolve(options.repo);
  const manifest = loadSyncManifest(resolve(repo, options.manifestPath));
  const statePath = resolve(repo, options.statePath);
  const state = loadSyncState(statePath);
  const headSha = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const outcomes: SyncOutcome[] = [];
  let stateDirty = false;

  for (const document of manifest.documents) {
    const entry = state.documents[document.output];
    const budgets = {
      model: document.model ?? options.defaults.model,
      maxTokens: document.maxTokens ?? options.defaults.maxTokens,
      maxInputBytes: document.maxInputBytes ?? options.defaults.maxInputBytes,
      maxFileBytes: document.maxFileBytes ?? options.defaults.maxFileBytes,
      maxDiffBytes: document.maxDiffBytes ?? options.defaults.maxDiffBytes,
    };
    const advance = (lastAction: string): void => {
      state.documents[document.output] = {
        headSha,
        syncedAt: new Date().toISOString(),
        lastAction,
      };
      stateDirty = true;
    };

    if (entry === undefined) {
      if (!options.dryRun) advance("baseline");
      outcomes.push({
        output: document.output,
        action: "baseline",
        detail: `first sync records ${headSha.slice(0, 12)} as the baseline; nothing is generated on a first run`,
        changedPaths: [],
        findings: [],
      });
      continue;
    }
    if (entry.headSha === headSha) {
      outcomes.push({
        output: document.output,
        action: "current",
        detail: "already reconciled against HEAD",
        changedPaths: [],
        findings: [],
      });
      continue;
    }

    let changedPaths: string[];
    try {
      changedPaths = changedPathsFor(repo, entry.headSha, headSha, document);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        output: document.output,
        action: "failed",
        detail: `the recorded baseline ${entry.headSha.slice(0, 12)} cannot be diffed against HEAD: ${message}. Delete this entry from the state file to re-baseline.`,
        changedPaths: [],
        findings: [],
      });
      continue;
    }
    if (changedPaths.length === 0) {
      if (!options.dryRun) advance("advanced");
      outcomes.push({
        output: document.output,
        action: "advanced",
        detail: "no evidence path changed in the range; baseline advanced without a model call",
        changedPaths: [],
        findings: [],
      });
      continue;
    }

    let findings: DocumentationFinding[];
    let passed: boolean;
    let summary: string;
    try {
      const audit = await checkDocumentation(
        {
          repo,
          output: document.output,
          sources: document.sources,
          base: entry.headSha,
          head: headSha,
          model: budgets.model,
          maxTokens: budgets.maxTokens,
          maxInputBytes: budgets.maxInputBytes,
          maxFileBytes: budgets.maxFileBytes,
          maxDiffBytes: budgets.maxDiffBytes,
          diffPaths: [...document.sources, document.output],
          ...(document.instruction === undefined ? {} : { instruction: document.instruction }),
        },
        client,
      );
      findings = audit.findings;
      passed = audit.passed;
      summary = audit.summary;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        output: document.output,
        action: "failed",
        detail: `audit did not complete: ${message}`,
        changedPaths,
        findings: [],
      });
      continue;
    }

    if (passed) {
      if (!options.dryRun) advance("checked-current");
      outcomes.push({
        output: document.output,
        action: "checked-current",
        detail: `audit passed: ${summary}`,
        changedPaths,
        findings,
      });
      continue;
    }

    if (options.dryRun) {
      outcomes.push({
        output: document.output,
        action: "rewritten",
        detail: `dry run: audit found blockers and a rewrite would be applied. ${summary}`,
        changedPaths,
        findings,
      });
      continue;
    }

    try {
      await writeDocumentation(
        {
          repo,
          output: document.output,
          sources: document.sources,
          model: budgets.model,
          maxTokens: budgets.maxTokens,
          maxInputBytes: budgets.maxInputBytes,
          maxFileBytes: budgets.maxFileBytes,
          apply: true,
          instruction: rewriteInstruction(document, findings),
        },
        client,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        output: document.output,
        action: "failed",
        detail: `audit found blockers but the rewrite did not complete: ${message}`,
        changedPaths,
        findings,
      });
      continue;
    }
    advance("rewritten");
    outcomes.push({
      output: document.output,
      action: "rewritten",
      detail: `audit found blockers; the document was regenerated with the findings as the correction brief. ${summary}`,
      changedPaths,
      findings,
    });
  }

  let stateWritten = false;
  if (stateDirty && !options.dryRun) {
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    stateWritten = true;
  }
  return { headSha, outcomes, stateWritten };
};
