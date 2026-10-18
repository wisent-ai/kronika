// What the command line says, as this product reads it: the shape of one
// parsed invocation (budgets only where a flag states them) and the loop that
// turns argv into that shape.

import type { OnboardingAction } from "../onboarding/onboarding.js";
import { MAX_PORT } from "./budgets.js";

type ParsedArguments = {
  command: "check" | "write" | "sources" | "sync" | "init" | "gui" | "onboarding" | "help";
  repo: string;
  output: string;
  sources: string[];
  documents: string[];
  model: string;
  maxInputBytes?: number;
  maxFileBytes?: number;
  maxTokens?: number;
  port: number;
  maxDiffBytes?: number;
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
const requiredValue = (flag: string, value: string | undefined): string => {
  if (value === undefined || !value.trim() || value.startsWith("--") || value === "-h") {
    throw new Error(`${flag} requires a value; another option cannot supply it`);
  }
  return value;
};

const positiveIntegerArgument = (flag: string, value: string | undefined): number => {
  const parsed = Number(requiredValue(flag, value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
};

const optionsByCommand: Record<Exclude<ParsedArguments["command"], "help">, readonly string[]> = {
  check: ["--repo", "--output", "--source", "--base", "--head", "--instruction", "--model",
    "--max-input-bytes", "--max-file-bytes", "--max-tokens", "--max-diff-bytes", "--json"],
  write: ["--repo", "--output", "--source", "--instruction", "--model",
    "--max-input-bytes", "--max-file-bytes", "--max-tokens", "--apply", "--json"],
  sources: ["--repo", "--output", "--source", "--max-input-bytes", "--max-file-bytes", "--json"],
  sync: ["--repo", "--manifest", "--state", "--model", "--max-input-bytes",
    "--max-file-bytes", "--max-tokens", "--max-diff-bytes", "--dry-run", "--commit", "--push", "--json"],
  init: ["--repo", "--manifest", "--docs", "--source", "--instruction", "--replace", "--json"],
  gui: ["--repo", "--port"],
  onboarding: ["--advance", "--skip", "--reset", "--status", "--json"],
};

const parseArguments = (argv: string[]): ParsedArguments => {
  const first = argv[0];
  const command = first === "check" || first === "write" || first === "sources" || first === "sync"
    || first === "init" || first === "gui" || first === "onboarding"
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
      port: 0,
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
    port: 0,
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
    if (flag !== "--help" && flag !== "-h" && !optionsByCommand[command].includes(flag)) {
      throw new Error(`${command} does not accept ${flag}`);
    }
    if (["--advance", "--skip", "--reset", "--status"].includes(flag)
      && parsed.onboarding !== "show") {
      throw new Error(`onboarding accepts one action; --${parsed.onboarding} conflicts with ${flag}`);
    }
    switch (flag) {
      case "--base":
        parsed.base = requiredValue(flag, value);
        index += 1;
        break;
      case "--head":
        parsed.head = requiredValue(flag, value);
        index += 1;
        break;
      case "--repo":
        parsed.repo = requiredValue(flag, value);
        index += 1;
        break;
      case "--port": {
        const parsedPort = positiveIntegerArgument(flag, value);
        if (parsedPort > MAX_PORT) throw new Error(`--port must be between 1 and ${MAX_PORT}`);
        parsed.port = parsedPort;
        index += 1;
        break;
      }
      case "--output":
        parsed.output = requiredValue(flag, value);
        index += 1;
        break;
      case "--docs":
        parsed.documents.push(requiredValue(flag, value));
        index += 1;
        break;
      case "--source":
        parsed.sources.push(requiredValue(flag, value));
        index += 1;
        break;
      case "--instruction":
        parsed.instruction = requiredValue(flag, value);
        index += 1;
        break;
      case "--model":
        parsed.model = requiredValue(flag, value);
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
      case "--manifest":
        parsed.manifest = requiredValue(flag, value);
        index += 1;
        break;
      case "--state":
        parsed.state = requiredValue(flag, value);
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
  if (parsed.command === "check" && !parsed.base) {
    throw new Error("check requires --base <ref>");
  }
  if (parsed.command === "sync" && parsed.push && !parsed.commit) {
    throw new Error("sync --push requires --commit");
  }

  return parsed;
};

export type { ParsedArguments };
export { parseArguments };
