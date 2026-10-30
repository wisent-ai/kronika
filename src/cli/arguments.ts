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
// Every refusal below names what was refused, why, and what to write instead:
// it is printed above the help, so a person reads it before anything else.
const requiredValue = (flag: string, value: string | undefined): string => {
  if (value === undefined) {
    throw new Error(`${flag} requires a value: it is the last word of the command line, so nothing follows it; write the value right after it (${flag} <value>)`);
  }
  if (!value.trim()) {
    throw new Error(`${flag} requires a value: the word after it is empty or only whitespace, which names nothing; write a non-blank value right after ${flag}, quoting it if it holds spaces`);
  }
  if (value.startsWith("--") || value === "-h") {
    throw new Error(`${flag} requires a value; another option cannot supply it: the word after it is the option ${value}, and kronika never reads one option as another's value; write ${flag}'s value right after it, before ${value}`);
  }
  return value;
};

/** Why `value` is not a positive safe integer, or undefined when it is one. */
const notPositiveInteger = (value: string, parsed: number): string | undefined => {
  if (Number.isNaN(parsed)) return `${JSON.stringify(value)} is not a number`;
  if (!Number.isInteger(parsed)) return `${JSON.stringify(value)} is not a whole number`;
  if (parsed === 0) return `${JSON.stringify(value)} is zero`;
  if (parsed < 0) return `${JSON.stringify(value)} is negative`;
  // Number.MAX_SAFE_INTEGER is the largest integer a JavaScript number holds exactly
  // (https://tc39.es/ecma262/#sec-number.max_safe_integer).
  if (!Number.isSafeInteger(parsed)) return `${JSON.stringify(value)} is larger than ${Number.MAX_SAFE_INTEGER}, the largest integer kronika can hold exactly`;
  return undefined;
};

const positiveIntegerArgument = (flag: string, value: string | undefined): number => {
  const text = requiredValue(flag, value);
  const parsed = Number(text);
  const reason = notPositiveInteger(text, parsed);
  if (reason) {
    throw new Error(`${flag} must be a positive integer: ${reason}; write a whole number of 1 or more after ${flag}`);
  }
  return parsed;
};

/** Why `command` refuses `flag`: which commands do take it, or that none does. */
const notAccepted = (command: string, flag: string): string => {
  const owners = Object.entries(optionsByCommand)
    .filter(([, options]) => options.includes(flag))
    .map(([owner]) => owner);
  if (owners.length) {
    return `${flag} belongs to ${owners.join(", ")}, and an option belonging to another command is refused rather than ignored`;
  }
  if (!flag.startsWith("-")) {
    return `${JSON.stringify(flag)} is not an option, and ${command} takes no positional word; a value belongs right after the option it is for`;
  }
  return `no kronika command has an option ${flag}; check its spelling`;
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
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
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
  if (command === "help") {
    const commands = Object.keys(optionsByCommand).join(", ");
    const why = first.startsWith("-")
      ? `the option ${first} came before any command, and the first word must name the command it belongs to`
      : `the first word names what kronika runs, and ${JSON.stringify(first)} is none of ${commands}`;
    throw new Error(`Unknown command: ${first}: ${why}; put one of ${commands} first (kronika <command> --help lists its options)`);
  }

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
    // The loop bound keeps index inside argv; the check states it to the compiler.
    if (flag === undefined) break;
    const value = argv[index + 1];
    if (flag !== "--help" && flag !== "-h" && !optionsByCommand[command].includes(flag)) {
      throw new Error(`${command} does not accept ${flag}: ${notAccepted(command, flag)}; ${command} accepts ${optionsByCommand[command].join(", ")} (kronika ${command} --help says what each does)`);
    }
    if (["--advance", "--skip", "--reset", "--status"].includes(flag)
      && parsed.onboarding !== "show") {
      throw new Error(`onboarding accepts one action; --${parsed.onboarding} conflicts with ${flag}: one run performs exactly one of --advance, --skip, --reset or --status; run each action as its own kronika onboarding command`);
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
        if (parsedPort > MAX_PORT) {
          throw new Error(`--port must be between 1 and ${MAX_PORT}: ${parsedPort} is not a TCP port, which is a 16-bit number; choose a free port of at most ${MAX_PORT}, or leave --port out and the operating system assigns a free one`);
        }
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
        throw new Error(`Unknown option: ${flag}: ${command} lists it as its own yet reads no value for it; this is a kronika defect, report it with this message`);
    }
  }
  if (parsed.command === "check" && !parsed.base) {
    throw new Error("check requires --base <ref>: check audits the change from a base commit to --head (default HEAD), and without --base it has no change to audit; name the commit the change starts from, for example --base origin/main");
  }
  if (parsed.command === "sync" && parsed.push && !parsed.commit) {
    throw new Error("sync --push requires --commit: --push publishes the commit sync makes, and without --commit sync makes no commit; add --commit, or leave out --push to keep the rewritten documents uncommitted");
  }

  return parsed;
};

export type { ParsedArguments };
export { parseArguments };
