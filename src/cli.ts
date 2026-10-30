#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { BramaClient } from "./docs/model/brama.js";
import { checkDocumentation } from "./docs/checker.js";
import { recordWorkspaceInitialized, renderOnboardingView, runOnboardingAction } from "./onboarding/onboarding.js";
import { startKronikaGui } from "./gui.js";
import { collectSources } from "./docs/sources.js";
import { initializeDocumentationWorkspace } from "./sync/project.js";
import type { CheckDocumentationOptions, WriteDocumentationOptions } from "./docs/model/types.js";
import { writeDocumentation } from "./docs/writer.js";
import { syncDocumentation } from "./sync/sync.js";

import { HELP, helpFor } from "./cli/help.js";
import { printAnswer } from "./cli/answer.js";
import { parseArguments } from "./cli/arguments.js";
import type { ParsedArguments } from "./cli/arguments.js";
import { readCredential } from "./cli/skarbiec.js";

// The exit statuses the CLI reference declares.
const EXIT_USAGE = 2; // https://kronika.wisent.com/docs/cli/ ("prints kronika: <message> and help on stderr with exit status 2")
const EXIT_FAILED = 1; // https://kronika.wisent.com/docs/cli/ ("Operational failures and blocker findings use status 1")

/** JSON a machine reads, one indented document per answer. */
const json = (value: unknown): string => `${JSON.stringify(value, null, "  ")}\n`;

const main = async (): Promise<void> => {
  // The words after node and this script.
  const [, , ...words] = process.argv;
  // Everything parseArguments refuses is the invocation itself: the usage
  // status with the help, apart from a failed run's status (cli.md rule 10).
  let args: ParsedArguments;
  try {
    args = parseArguments(words);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kronika: ${message}\n\n${HELP}\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (args.command === "help") {
    // `kronika check --help` answers about check; `kronika --help` about all.
    const [first] = words;
    process.stdout.write(`${first && !first.startsWith("-") ? helpFor(first) : HELP}\n`);
    return;
  }

  if (args.command === "onboarding") {
    const result = await runOnboardingAction(args.onboarding, { client: "cli" });
    process.stdout.write(args.json ? json(result) : `${renderOnboardingView(result)}\n`);
    return;
  }
  if (args.command === "gui") {
    const gui = await startKronikaGui({
      repo: args.repo,
      ...(args.port ? { port: args.port } : {}),
    });
    process.stdout.write(`Kronika graphical importer: ${gui.url}\n`);
    return;
  }
  if (args.command === "init") {
    const result = initializeDocumentationWorkspace({
      repo: args.repo,
      manifestPath: args.manifest,
      ...(args.documents.length ? { documents: args.documents } : {}),
      ...(args.sources.length ? { sources: args.sources } : {}),
      ...(args.instruction ? { instruction: args.instruction } : {}),
      replace: args.replace,
    });
    if (result.accepted) {
      const onboarding = await recordWorkspaceInitialized({
        client: "cli",
        documentCount: result.imported.length + result.unchanged.length,
        manifestPath: result.manifestPath,
      });
      printAnswer({ ...result, onboarding }, args.json);
      return;
    }
    printAnswer(result, args.json);
    process.exitCode = EXIT_FAILED;
    return;
  }

  // A byte limit applies only when its flag is given; otherwise every source is read whole.
  const sourceOptions = () => ({
    repo: args.repo,
    output: args.output,
    ...(args.maxInputBytes === undefined ? {} : { maxInputBytes: args.maxInputBytes }),
    ...(args.maxFileBytes === undefined ? {} : { maxFileBytes: args.maxFileBytes }),
    ...(args.sources.length ? { sources: args.sources } : {}),
  });

  if (args.command === "sources") {
    const collection = collectSources(sourceOptions());
    printAnswer({
      repo: args.repo,
      output: args.output,
      totalBytes: collection.totalBytes,
      sources: collection.documents.map(({ path, bytes }) => ({ path, bytes })),
      skipped: collection.skipped,
    }, args.json);
    return;
  }

  const bramaUrl = process.env.BRAMA_URL;
  // Only role references travel in the environment; the secrets themselves
  // are read through Stado by the role their item plays (cli.md rule 15).
  const apiKeyRole = process.env.BRAMA_API_KEY_ROLE;
  const agentId = process.env.WISENT_APP_AGENT_ID;
  const authSecretRole = process.env.WISENT_APP_AGENT_AUTH_SECRET_ROLE;
  if (!bramaUrl) {
    throw new Error(`BRAMA_URL is required: ${args.command} asks a model through Brama, and BRAMA_URL, the address of the Brama gateway or another OpenAI-compatible provider, is ${bramaUrl === undefined ? "not set" : "set but empty"}; export BRAMA_URL=<gateway URL>, or run kronika sources, which reads the repository without a model`);
  }
  if (!apiKeyRole) {
    throw new Error(`BRAMA_API_KEY_ROLE is required: ROLE#FIELD naming the role the item holding the Brama bearer plays, and its field; it is ${apiKeyRole === undefined ? "not set" : "set but empty"}, so no bearer can be read for ${bramaUrl}; export BRAMA_API_KEY_ROLE=<role>#<field> for the item stado credentials get answers, or set KRONIKA_CREDENTIALS_FILE to an owner-only JSON file of role -> field -> value`);
  }
  const apiKey = readCredential(apiKeyRole, "BRAMA_API_KEY_ROLE");
  const authSecret = authSecretRole ? readCredential(authSecretRole, "WISENT_APP_AGENT_AUTH_SECRET_ROLE") : undefined;

  const client = new BramaClient({
    url: bramaUrl,
    apiKey,
    ...(agentId ? { agentId } : {}),
    ...(authSecret ? { authSecret } : {}),
  });

  if (args.command === "sync") {
    const result = await syncDocumentation(
      {
        repo: args.repo,
        manifestPath: args.manifest,
        statePath: args.state,
        dryRun: args.dryRun,
        defaults: {
          model: args.model,
          maxTokens: args.maxTokens,
          maxInputBytes: args.maxInputBytes,
          maxFileBytes: args.maxFileBytes,
          maxDiffBytes: args.maxDiffBytes,
        },
      },
      client,
    );
    const rewritten = result.outcomes.filter((outcome) => outcome.action === "rewritten");
    const failed = result.outcomes.filter((outcome) => outcome.action === "failed");
    let committed = false;
    if (args.commit && !args.dryRun && (rewritten.length || result.stateWritten)) {
      const paths = [...rewritten.map((outcome) => outcome.output), args.state];
      execFileSync("git", ["-C", args.repo, "add", "--", ...paths], { stdio: "inherit" });
      const subject = rewritten.length
        ? `kronika sync: reconcile ${rewritten.map((outcome) => outcome.output).join(", ")}`
        : "kronika sync: advance documentation baselines";
      execFileSync("git", ["-C", args.repo, "commit", "-m", subject], { stdio: "inherit" });
      committed = true;
      if (args.push) {
        execFileSync("git", ["-C", args.repo, "push"], { stdio: "inherit" });
      }
    }
    if (args.json) {
      process.stdout.write(json({
        headSha: result.headSha,
        dryRun: args.dryRun,
        committed,
        stateWritten: result.stateWritten,
        outcomes: result.outcomes,
      }));
    } else {
      process.stdout.write(`Kronika sync at ${result.headSha}${args.dryRun ? " (dry run)" : ""}\n`);
      // The action column is as wide as the longest action this run reports.
      const width = Math.max(...result.outcomes.map((outcome) => outcome.action.length));
      for (const outcome of result.outcomes) {
        process.stdout.write(`  ${outcome.action.padEnd(width)} ${outcome.output} — ${outcome.detail}\n`);
      }
      if (committed) process.stdout.write(`  committed${args.push ? " and pushed" : ""}\n`);
    }
    if (failed.length) process.exitCode = EXIT_FAILED;
    return;
  }
  if (args.command === "check") {
    if (args.base === undefined) throw new Error("check requires --base <ref>");
    const checkOptions: CheckDocumentationOptions = {
      ...sourceOptions(),
      base: args.base,
      head: args.head,
      model: args.model,
      ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
      ...(args.maxDiffBytes === undefined ? {} : { maxDiffBytes: args.maxDiffBytes }),
      ...(args.instruction ? { instruction: args.instruction } : {}),
    };
    const result = await checkDocumentation(checkOptions, client);
    if (args.json) {
      process.stdout.write(json({
        passed: result.passed,
        summary: result.summary,
        findings: result.findings,
        ...(result.model ? { model: result.model } : {}),
        baseSha: result.baseSha,
        headSha: result.headSha,
        changedPaths: result.changedPaths,
        diffBytes: result.diffBytes,
        sourceCount: result.sources.length,
        skipped: result.skipped,
      }));
    } else {
      process.stdout.write(`Kronika documentation check: ${result.passed ? "PASSED" : "BLOCKED"}\n${result.summary}\n`);
      for (const finding of result.findings) {
        process.stdout.write(`  - ${finding.severity}: ${finding.message}\n`);
      }
    }
    if (!result.passed) process.exitCode = EXIT_FAILED;
    return;
  }
  const writeOptions: WriteDocumentationOptions = {
    ...sourceOptions(),
    model: args.model,
    ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
    apply: args.apply,
    ...(args.instruction ? { instruction: args.instruction } : {}),
  };
  const result = await writeDocumentation(writeOptions, client);

  if (args.json) {
    process.stdout.write(json({
      outputPath: result.outputPath,
      applied: result.applied,
      ...(result.model ? { model: result.model } : {}),
      sourceCount: result.sources.length,
      skipped: result.skipped,
      ...(!result.applied ? { content: result.content } : {}),
    }));
  } else if (result.applied) {
    process.stdout.write(`Wrote ${result.outputPath} from ${result.sources.length} source files via Brama.\n`);
  } else {
    process.stdout.write(result.content);
  }
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kronika: ${message}\n`);
  process.exitCode = EXIT_FAILED;
});
