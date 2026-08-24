import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkDocumentation } from "./checker.js";
import type {
  CompletionClient,
  DocumentationFinding,
} from "./types.js";
import { writeDocumentation } from "./writer.js";

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

export const SYNC_MANIFEST_FILE = "kronika.sync.json";
export const SYNC_STATE_FILE = "kronika.sync-state.json";

export type SyncDocument = {
  /** Repository-relative documentation file this entry maintains. */
  output: string;
  /** Repository-relative files or directories that are this document's
   * evidence; also the pathspecs drift detection filters the Git diff by. */
  sources: string[];
  /** Standing documentation goal passed to both the audit and the rewrite. */
  instruction?: string;
  model?: string;
  maxTokens?: number;
  maxInputBytes?: number;
  maxFileBytes?: number;
  maxDiffBytes?: number;
};

export type SyncManifest = {
  schemaVersion: number;
  documents: SyncDocument[];
};

type SyncStateEntry = {
  headSha: string;
  syncedAt: string;
  lastAction: string;
};

export type SyncState = {
  schemaVersion: number;
  documents: Record<string, SyncStateEntry>;
};

export type SyncOutcome = {
  output: string;
  action: "baseline" | "current" | "advanced" | "checked-current" | "rewritten" | "failed";
  detail: string;
  changedPaths: string[];
  findings: DocumentationFinding[];
};

export type SyncDefaults = {
  model: string;
  maxTokens: number;
  maxInputBytes: number;
  maxFileBytes: number;
  maxDiffBytes: number;
};

export type SyncOptions = {
  repo: string;
  manifestPath: string;
  statePath: string;
  dryRun: boolean;
  defaults: SyncDefaults;
};

export type SyncResult = {
  headSha: string;
  outcomes: SyncOutcome[];
  stateWritten: boolean;
};

const git = (repo: string, args: string[]): string => execFileSync(
  "git",
  ["-C", repo, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
).trim();

export const loadSyncManifest = (path: string): SyncManifest => {
  if (!existsSync(path)) {
    throw new Error(`Sync manifest is missing: ${path}. Declare the maintained documents first.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Sync manifest is not valid JSON: ${path}`);
  }
  const manifest = parsed as SyncManifest;
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported sync manifest schemaVersion in ${path}`);
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error(`Sync manifest declares no documents: ${path}`);
  }
  for (const document of manifest.documents) {
    if (typeof document.output !== "string" || document.output.length === 0) {
      throw new Error(`Sync manifest entry without an output path in ${path}`);
    }
    if (!Array.isArray(document.sources) || document.sources.length === 0) {
      throw new Error(`Sync manifest entry ${document.output} declares no sources`);
    }
  }
  return manifest;
};

const loadSyncState = (path: string): SyncState => {
  if (!existsSync(path)) {
    return { schemaVersion: 1, documents: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Sync state is not valid JSON: ${path}. Fix or delete it to re-baseline.`);
  }
  const state = parsed as SyncState;
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported sync state schemaVersion in ${path}`);
  }
  if (state.documents === undefined || state.documents === null) {
    state.documents = {};
  }
  return state;
};

/** Changed paths between two commits, restricted to this document's evidence
 * and to the document itself — a hand edit to the document must advance its
 * baseline exactly like a source change that the audit passes. */
const changedPathsFor = (
  repo: string,
  baseSha: string,
  headSha: string,
  document: SyncDocument,
): string[] => {
  const names = git(repo, [
    "diff",
    "--name-only",
    "--find-renames",
    `${baseSha}...${headSha}`,
    "--",
    ...document.sources,
    document.output,
  ]);
  return names.length === 0 ? [] : names.split("\n");
};

const rewriteInstruction = (document: SyncDocument, findings: DocumentationFinding[]): string => {
  const defects = findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => {
      const change = finding.requiredChange === null ? "" : ` Required change: ${finding.requiredChange}`;
      return `- [${finding.code}] ${finding.message}${change}`;
    })
    .join("\n");
  const standing = document.instruction === undefined ? "" : `${document.instruction}\n\n`;
  return `${standing}Preserve the document's existing structure, voice, and correct content. Correct exactly the audited defects below; do not re-author sections the audit did not name.\n${defects}`;
};

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
