#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { BramaClient } from "./brama.js";
import { checkDocumentation } from "./checker.js";
import type { OnboardingAction } from "./onboarding.js";
import { recordWorkspaceInitialized, renderOnboardingView, runOnboardingAction } from "./onboarding.js";
import { collectSources } from "./sources.js";
import { initializeDocumentationWorkspace } from "./project.js";
import type { CheckDocumentationOptions, WriteDocumentationOptions } from "./types.js";
import { writeDocumentation } from "./writer.js";
import { syncDocumentation } from "./sync.js";

type ParsedArguments = {
  command: "check" | "write" | "sources" | "sync" | "init" | "onboarding" | "help";
  repo: string;
  output: string;
  sources: string[];
  documents: string[];
  model: string;
  maxInputBytes: number;
  maxFileBytes: number;
  maxTokens: number;
  timeoutMs: number;
  maxDiffBytes: number;
  apply: boolean;
  json: boolean;
  base?: string;
  head: string;
  instruction?: string;
  manifest: string;
  state: string;
  dryRun: boolean;
  commit: boolean;
  push: boolean;
  replace: boolean;
  onboarding: OnboardingAction;
};

const HELP = `Kronika — source-grounded documentation writing through Brama

Usage:
  kronika init [--docs <path>] [--source <path>] [--replace] [options]
  kronika sources [options]
  kronika check --base <ref> [options]
  kronika write [options]
  kronika sync [options]
  kronika onboarding [--advance | --skip | --reset | --status] [--json]

Commands:
  init                  Adopt existing repository documentation into the
                        canonical kronika.sync.json project manifest
  check                 Audit one exact Git change against current documentation
  sources               Show the safe source manifest without calling Brama
  write                 Generate complete Markdown through Brama
  sync                  Reconcile every manifest-declared document with the
                        repository: audit drifted ones, rewrite only audited
                        defects, and record the reconciled commit
  onboarding            Walk the first-use journey Kronika ships, one screen at
                        a time, and replay it with --reset

Options:
  --repo <path>          Repository root (default: current directory)
  --output <path>        Target document inside the repository (default: README.md)
  --docs <path>          Existing Markdown file or directory for init; repeatable
  --source <path>        Explicit source file or directory; repeatable
  --base <ref>           Base Git commit for check (required)
  --head <ref>           Head Git commit for check (default: HEAD)
  --instruction <text>   Additional documentation goal
  --model <selector>     Brama model selector (default: KRONIKA_MODEL or any)
  --max-input-bytes <n>  Total source budget (default: 200000)
  --max-file-bytes <n>   Per-file source limit (default: 64000)
  --max-tokens <n>       Completion token budget (default: 8000)
  --max-diff-bytes <n>   Git diff budget for check (default: 200000)
  --timeout-ms <n>       Brama request timeout (default: 120000)
  --apply                Atomically replace the target document
  --manifest <path>      Sync manifest inside the repository (default: kronika.sync.json)
  --state <path>         Sync state file inside the repository (default: kronika.sync-state.json)
  --dry-run              Sync: report and audit, but write no file and no state
  --commit               Sync: commit rewritten documents and the state file
  --push                 Sync: push the sync commit
  --replace              Init: replace a conflicting existing sync manifest
  --advance              Onboarding: move to the next screen
  --skip                 Onboarding: dismiss the journey
  --reset                Onboarding: replay the journey from its first screen
  --status               Onboarding: report an existing attempt without starting one
  --json                 Emit a machine-readable result
  -h, --help             Show this help

Brama environment:
  BRAMA_URL (or MODEL_ROUTER_URL)
  WISENT_APP_AGENT_ID
  WISENT_APP_AGENT_AUTH_SECRET
  KRONIKA_MODEL (optional)

Without --apply, write prints the generated Markdown and does not change files.
Check exits non-zero when it reports a documentation blocker.
Sync's first run for a document records a baseline and generates nothing;
every later run audits only documents whose declared sources changed, and
exits non-zero when any document failed to reconcile.
Onboarding needs no Brama route: it completes when kronika init durably
adopts an existing documentation workspace.`;

const positiveIntegerArgument = (flag: string, value: string | undefined): number => {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
};

const parseArguments = (argv: string[]): ParsedArguments => {
  const first = argv[0];
  const command = first === "check" || first === "write" || first === "sources" || first === "sync"
    || first === "init" || first === "onboarding"
    ? first
    : "help";
  if (first === "help" || first === "--help" || first === "-h" || argv.length === 0) {
    return {
      command: "help",
      repo: process.cwd(),
      output: "README.md",
      sources: [],
      documents: [],
      model: process.env.KRONIKA_MODEL || "any",
      maxInputBytes: 200_000,
      maxFileBytes: 64_000,
      maxTokens: 8_000,
      timeoutMs: 120_000,
      maxDiffBytes: 200_000,
      apply: false,
      json: false,
      head: "HEAD",
      manifest: "kronika.sync.json",
      state: "kronika.sync-state.json",
      dryRun: false,
      commit: false,
      push: false,
      replace: false,
      onboarding: "show",
    };
  }
  if (command === "help") throw new Error(`Unknown command: ${first}`);

  const parsed: ParsedArguments = {
    command,
    repo: process.cwd(),
    output: "README.md",
    sources: [],
    documents: [],
    model: process.env.KRONIKA_MODEL || "any",
    maxInputBytes: 200_000,
    maxFileBytes: 64_000,
    maxTokens: 8_000,
    timeoutMs: 120_000,
    maxDiffBytes: 200_000,
    apply: false,
    json: false,
    head: "HEAD",
    manifest: "kronika.sync.json",
    state: "kronika.sync-state.json",
    dryRun: false,
    commit: false,
    push: false,
    replace: false,
    onboarding: "show",
  };

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--base":
        if (value === undefined) throw new Error("--base requires a value");
        parsed.base = value;
        index += 1;
        break;
      case "--head":
        if (value === undefined) throw new Error("--head requires a value");
        parsed.head = value;
        index += 1;
        break;
      case "--repo":
        if (value === undefined) throw new Error("--repo requires a value");
        parsed.repo = value;
        index += 1;
        break;
      case "--output":
        if (value === undefined) throw new Error("--output requires a value");
        parsed.output = value;
        index += 1;
        break;
      case "--docs":
        if (value === undefined) throw new Error("--docs requires a value");
        parsed.documents.push(value);
        index += 1;
        break;
      case "--source":
        if (value === undefined) throw new Error("--source requires a value");
        parsed.sources.push(value);
        index += 1;
        break;
      case "--instruction":
        if (value === undefined) throw new Error("--instruction requires a value");
        parsed.instruction = value;
        index += 1;
        break;
      case "--model":
        if (value === undefined) throw new Error("--model requires a value");
        parsed.model = value;
        index += 1;
        break;
      case "--max-input-bytes":
        parsed.maxInputBytes = positiveIntegerArgument(flag, value);
        index += 1;
        break;
      case "--max-file-bytes":
        parsed.maxFileBytes = positiveIntegerArgument(flag, value);
        index += 1;
        break;
      case "--max-tokens":
        parsed.maxTokens = positiveIntegerArgument(flag, value);
        index += 1;
        break;
      case "--max-diff-bytes":
        parsed.maxDiffBytes = positiveIntegerArgument(flag, value);
        index += 1;
        break;
      case "--timeout-ms":
        parsed.timeoutMs = positiveIntegerArgument(flag, value);
        index += 1;
        break;
      case "--manifest":
        if (value === undefined) throw new Error("--manifest requires a value");
        parsed.manifest = value;
        index += 1;
        break;
      case "--state":
        if (value === undefined) throw new Error("--state requires a value");
        parsed.state = value;
        index += 1;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--commit":
        parsed.commit = true;
        break;
      case "--push":
        parsed.push = true;
        break;
      case "--replace":
        parsed.replace = true;
        break;
      case "--advance":
        parsed.onboarding = "advance";
        break;
      case "--skip":
        parsed.onboarding = "skip";
        break;
      case "--reset":
        parsed.onboarding = "reset";
        break;
      case "--status":
        parsed.onboarding = "status";
        break;
      case "--apply":
        parsed.apply = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "-h":
      case "--help":
        parsed.command = "help";
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return parsed;
};

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
