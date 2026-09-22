#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { BramaClient } from "./docs/model/brama.js";
import { checkDocumentation } from "./docs/checker.js";
import type { OnboardingAction } from "./onboarding/onboarding.js";
import { recordWorkspaceInitialized, renderOnboardingView, runOnboardingAction } from "./onboarding/onboarding.js";
import { startKronikaGui } from "./gui.js";
import { collectSources } from "./docs/sources.js";
import { initializeDocumentationWorkspace } from "./sync/project.js";
import type { CheckDocumentationOptions, WriteDocumentationOptions } from "./docs/model/types.js";
import { writeDocumentation } from "./docs/writer.js";
import { syncDocumentation } from "./sync/sync.js";

import { HELP } from "./cli/help.js";
import { parseArguments } from "./cli/arguments.js";

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (args.command === "onboarding") {
    const result = await runOnboardingAction(args.onboarding, { client: "cli" });
    process.stdout.write(args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${renderOnboardingView(result)}\n`);
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
      ...(args.documents.length > 0 ? { documents: args.documents } : {}),
      ...(args.sources.length > 0 ? { sources: args.sources } : {}),
      ...(args.instruction ? { instruction: args.instruction } : {}),
      replace: args.replace,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "imported" || result.status === "unchanged") {
      await recordWorkspaceInitialized({
        client: "cli",
        documentCount: result.imported.length + result.unchanged.length,
        manifestPath: result.manifestPath,
      });
      return;
    }
    process.exitCode = 1;
    return;
  }

  const sourceOptions = {
    repo: args.repo,
    output: args.output,
    maxInputBytes: args.maxInputBytes,
    maxFileBytes: args.maxFileBytes,
    ...(args.sources.length > 0 ? { sources: args.sources } : {}),
  };

  if (args.command === "sources") {
    const collection = collectSources(sourceOptions);
    process.stdout.write(`${JSON.stringify({
      repo: args.repo,
      output: args.output,
      totalBytes: collection.totalBytes,
      sources: collection.documents.map(({ path, bytes }) => ({ path, bytes })),
      skipped: collection.skipped,
    }, null, 2)}\n`);

    return;
  }

  if (args.command === "check" && !args.base) {
    throw new Error("check requires --base <ref>");
  }

  const bramaUrl = process.env.BRAMA_URL || process.env.MODEL_ROUTER_URL;
  const apiKey = process.env.BRAMA_API_KEY || process.env.MODEL_ROUTER_TOKEN;
  const agentId = process.env.WISENT_APP_AGENT_ID;
  const authSecret = process.env.WISENT_APP_AGENT_AUTH_SECRET;
  if (!bramaUrl) throw new Error("BRAMA_URL or MODEL_ROUTER_URL is required");
  if (!apiKey) throw new Error("BRAMA_API_KEY or MODEL_ROUTER_TOKEN is required");

  const client = new BramaClient({
    url: bramaUrl,
    apiKey,
    ...(agentId ? { agentId } : {}),
    ...(authSecret ? { authSecret } : {}),
    timeoutMs: args.timeoutMs,
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
    if (args.commit && !args.dryRun && (rewritten.length > 0 || result.stateWritten)) {
      const paths = [...rewritten.map((outcome) => outcome.output), args.state];
      execFileSync("git", ["-C", args.repo, "add", "--", ...paths], { stdio: "inherit" });
      const subject = rewritten.length > 0
        ? `kronika sync: reconcile ${rewritten.map((outcome) => outcome.output).join(", ")}`
        : "kronika sync: advance documentation baselines";
      execFileSync("git", ["-C", args.repo, "commit", "-m", subject], { stdio: "inherit" });
      committed = true;
      if (args.push) {
        execFileSync("git", ["-C", args.repo, "push"], { stdio: "inherit" });
      }
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        headSha: result.headSha,
        dryRun: args.dryRun,
        committed,
        stateWritten: result.stateWritten,
        outcomes: result.outcomes,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`Kronika sync at ${result.headSha.slice(0, 12)}${args.dryRun ? " (dry run)" : ""}\n`);
      for (const outcome of result.outcomes) {
        process.stdout.write(`  ${outcome.action.padEnd(15)} ${outcome.output} — ${outcome.detail}\n`);
      }
      if (committed) process.stdout.write(`  committed${args.push ? " and pushed" : ""}\n`);
    }
    process.exitCode = failed.length > 0 ? 1 : 0;
    return;
  }
  if (args.command === "check") {
    const checkOptions: CheckDocumentationOptions = {
      ...sourceOptions,
      base: args.base ?? "",
      head: args.head,
      model: args.model,
      maxTokens: args.maxTokens,
      maxDiffBytes: args.maxDiffBytes,
      ...(args.instruction ? { instruction: args.instruction } : {}),
    };
    const result = await checkDocumentation(checkOptions, client);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        passed: result.passed,
        summary: result.summary,
        findings: result.findings,
        model: result.model ?? null,
        baseSha: result.baseSha,
        headSha: result.headSha,
        changedPaths: result.changedPaths,
        diffBytes: result.diffBytes,
        sourceCount: result.sources.length,
        skipped: result.skipped,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`Kronika documentation check: ${result.passed ? "PASSED" : "BLOCKED"}\n${result.summary}\n`);
      for (const finding of result.findings) {
        process.stdout.write(`  - ${finding.severity}: ${finding.message}\n`);
      }
    }
    process.exitCode = result.passed ? 0 : 1;
    return;
  }
  const writeOptions: WriteDocumentationOptions = {
    ...sourceOptions,
    model: args.model,
    maxTokens: args.maxTokens,
    apply: args.apply,
    ...(args.instruction ? { instruction: args.instruction } : {}),
  };
  const result = await writeDocumentation(writeOptions, client);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      outputPath: result.outputPath,
      applied: result.applied,
      model: result.model ?? null,
      sourceCount: result.sources.length,
      skipped: result.skipped,
      ...(!result.applied ? { content: result.content } : {}),
    }, null, 2)}\n`);
  } else if (result.applied) {
    process.stdout.write(`Wrote ${result.outputPath} from ${result.sources.length} source files via Brama.\n`);
  } else {
    process.stdout.write(result.content);
  }
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kronika: ${message}\n`);
  process.exitCode = 1;
});
