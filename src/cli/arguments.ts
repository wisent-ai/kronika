// What the command line says, as this product reads it: the shape of one
// parsed invocation, the budgets a run starts with unless a flag says
// otherwise, and the loop that turns argv into that shape.

import type { OnboardingAction } from "../onboarding/onboarding.js";
import {
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_PORT,
} from "./budgets.js";

type ParsedArguments = {
  command: "check" | "write" | "sources" | "sync" | "init" | "gui" | "onboarding" | "help";
  repo: string;
  output: string;
  sources: string[];
  documents: string[];
  model: string;
  maxInputBytes: number;
  maxFileBytes: number;
  maxTokens: number;
  port: number;
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
      maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxTokens: DEFAULT_MAX_TOKENS,
      port: 0,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxDiffBytes: DEFAULT_MAX_DIFF_BYTES,
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
    maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxDiffBytes: DEFAULT_MAX_DIFF_BYTES,
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
      case "--port": {
        const parsedPort = positiveIntegerArgument(flag, value);
        if (parsedPort > MAX_PORT) throw new Error(`--port must be between 1 and ${MAX_PORT}`);
        parsed.port = parsedPort;
        index += 1;
        break;
      }
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

export type { ParsedArguments };
export { parseArguments };
