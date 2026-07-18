#!/usr/bin/env node

import { BramaClient } from "./brama.js";
import { collectSources } from "./sources.js";
import type { WriteDocumentationOptions } from "./types.js";
import { writeDocumentation } from "./writer.js";

type ParsedArguments = {
  command: "write" | "sources" | "help";
  repo: string;
  output: string;
  sources: string[];
  model: string;
  maxInputBytes: number;
  maxFileBytes: number;
  maxTokens: number;
  timeoutMs: number;
  apply: boolean;
  json: boolean;
  instruction?: string;
};

const HELP = `Kronika — source-grounded documentation writing through Brama

Usage:
  kronika sources [options]
  kronika write [options]

Commands:
  sources               Show the safe source manifest without calling Brama
  write                 Generate complete Markdown through Brama

Options:
  --repo <path>          Repository root (default: current directory)
  --output <path>        Target document inside the repository (default: README.md)
  --source <path>        Explicit source file or directory; repeatable
  --instruction <text>   Additional documentation goal
  --model <selector>     Brama model selector (default: KRONIKA_MODEL or any)
  --max-input-bytes <n>  Total source budget (default: 200000)
  --max-file-bytes <n>   Per-file source limit (default: 64000)
  --max-tokens <n>       Completion token budget (default: 8000)
  --timeout-ms <n>       Brama request timeout (default: 120000)
  --apply                Atomically replace the target document
  --json                 Emit a machine-readable result
  -h, --help             Show this help

Brama environment:
  BRAMA_URL (or MODEL_ROUTER_URL)
  WISENT_APP_AGENT_ID
  WISENT_APP_AGENT_AUTH_SECRET
  KRONIKA_MODEL (optional)

Without --apply, write prints the generated Markdown and does not change files.`;

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
  const command = first === "write" || first === "sources" ? first : "help";
  if (first === "help" || first === "--help" || first === "-h" || argv.length === 0) {
    return {
      command: "help",
      repo: process.cwd(),
      output: "README.md",
      sources: [],
      model: process.env.KRONIKA_MODEL || "any",
      maxInputBytes: 200_000,
      maxFileBytes: 64_000,
      maxTokens: 8_000,
      timeoutMs: 120_000,
      apply: false,
      json: false,
    };
  }
  if (command === "help") throw new Error(`Unknown command: ${first}`);

  const parsed: ParsedArguments = {
    command,
    repo: process.cwd(),
    output: "README.md",
    sources: [],
    model: process.env.KRONIKA_MODEL || "any",
    maxInputBytes: 200_000,
    maxFileBytes: 64_000,
    maxTokens: 8_000,
    timeoutMs: 120_000,
    apply: false,
    json: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
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
      case "--timeout-ms":
        parsed.timeoutMs = positiveIntegerArgument(flag, value);
        index += 1;
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

  const bramaUrl = process.env.BRAMA_URL || process.env.MODEL_ROUTER_URL;
  const agentId = process.env.WISENT_APP_AGENT_ID;
  const authSecret = process.env.WISENT_APP_AGENT_AUTH_SECRET;
  if (!bramaUrl) throw new Error("BRAMA_URL or MODEL_ROUTER_URL is required");
  if (!agentId) throw new Error("WISENT_APP_AGENT_ID is required");
  if (!authSecret) throw new Error("WISENT_APP_AGENT_AUTH_SECRET is required");

  const client = new BramaClient({
    url: bramaUrl,
    agentId,
    authSecret,
    timeoutMs: args.timeoutMs,
  });
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
