// Shared helpers for docs-cli modules. Node builtins only.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// A gateway that answers with one of these is down, not refusing the request.
const INFRA_DOWN_STATUSES = [
  502, // https://www.rfc-editor.org/rfc/rfc9110#section-15.6.3 "502 Bad Gateway"
  503, // https://www.rfc-editor.org/rfc/rfc9110#section-15.6.4 "503 Service Unavailable"
  504, // https://www.rfc-editor.org/rfc/rfc9110#section-15.6.5 "504 Gateway Timeout"
];

// The exit statuses every entry point answers with.
export const EXIT_USAGE = 2; // https://github.com/wisent-ai/kronika/blob/main/docs/site-pipeline.md "exits 2 on an unknown option or a missing argument"
export const EXIT_STAGE_FAILED = 1; // https://github.com/wisent-ai/kronika/blob/main/docs/site-pipeline.md "1 means a stage failed"
export const EXIT_BRAMA_DOWN = 69; // https://github.com/wisent-ai/kronika/blob/main/docs/site-pipeline.md "69 that Brama is down"

export function expandPath(p, base = process.cwd()) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice("~/".length));
  return path.resolve(base, p);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Parse one entry point's command line the same way everywhere: `--help`
 * prints the usage and exits successfully, `--text` is always accepted, and a
 * command line parseArgs refuses (unknown option, missing value) or that lacks
 * a `required` option exits EXIT_USAGE with the reason and the usage (cli.md
 * rules 10, 11). `shape` names the command's positional arguments in order
 * and the options it requires; a caller that names neither is refused.
 * Returns `{ values, positionals }`: parseArgs's option values and each
 * positional argument under its name.
 */
export function parseCommand(usage, options, { positionals, required }) {
  if (!Array.isArray(positionals) || !Array.isArray(required)) {
    throw new TypeError(`parseCommand for "${usage}" needs { positionals: [<name>...], required: [<option>...] }`);
  }
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: Boolean(positionals.length),
      options: { ...options, text: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
    });
  } catch (error) {
    printReport({ error: "usage", detail: `${error.message}; usage: ${usage}` });
    process.exit(EXIT_USAGE);
  }
  if (parsed.values.help) {
    process.stdout.write(`usage: ${usage}\n\nResults print as JSON; --text prints the same report as one path: value line per field.\n`);
    process.exit();
  }
  const missing = required.filter((name) => !parsed.values[name]);
  if (parsed.positionals.length !== positionals.length || missing.length) {
    const reason = missing.length
      ? `missing --${missing.join(", --")}`
      : `expected the positional argument(s) <${positionals.join("> <")}>`;
    printReport({ error: "usage", detail: `${reason}; usage: ${usage}` });
    process.exit(EXIT_USAGE);
  }
  const named = Object.fromEntries(positionals.map((name, index) => [name, parsed.positionals.at(index)]));
  return { values: parsed.values, positionals: named };
}

// JSON for machines; with --text one `path: value` line per field of the
// same report (cli.md rule 13).
export function printReport(report) {
  if (!process.argv.includes("--text")) {
    process.stdout.write(JSON.stringify(report, null, "  ") + "\n");
    return;
  }
  const lines = [];
  const walk = (node, at) => {
    if (Array.isArray(node) && node.length) node.forEach((item, index) => walk(item, `${at}[${index}]`));
    else if (node && typeof node === "object" && Object.keys(node).length) {
      for (const [key, item] of Object.entries(node)) walk(item, at ? `${at}.${key}` : key);
    } else lines.push(`${at}: ${node === null || typeof node === "object" ? "-" : node}`);
  };
  walk(report, "");
  process.stdout.write(lines.join("\n") + "\n");
}

export function die(report, code) {
  printReport(report);
  process.exit(code);
}

/**
 * Run a binary directly (no shell) in `cwd`. Resolves with { ok, code, signal,
 * stdout, stderr, error } when it exits: `code` is its exit status, null when
 * it never started or a signal (`signal`) ended it, and `error` says which.
 * Its standard input is closed at once, so a binary that would read a prompt
 * sees end of input and answers instead of waiting.
 */
export function runCommand(file, args, { cwd }) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd, maxBuffer: Infinity, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: child.exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
          error: error?.message,
        });
      },
    );
    child.stdin?.end();
  });
}

/**
 * Fetch a URL as text. Resolves { ok, status?, text?, error? }: the answer, an
 * HTTP failure with its status and body, or the connection failure with its
 * cause.
 */
export async function fetchText(url) {
  let res;
  let text;
  try {
    res = await fetch(url, { redirect: "follow" });
    text = await res.text();
  } catch (error) {
    return failedFetch(url, error);
  }
  if (!res.ok) return { ok: false, status: res.status, error: `${url}: HTTP ${res.status}: ${text}` };
  return { ok: true, status: res.status, text };
}

function failedFetch(url, error) {
  const reasons = [error.message];
  if (error.cause !== undefined) reasons.push(`cause: ${error.cause.message ?? error.cause}`);
  return { ok: false, error: `${url}: ${reasons.join("; ")}` };
}

// --- Model endpoint (Brama) ------------------------------------------------

/** Where `stado service directory publish` writes the address this machine dials for Brama. */
export const BRAMA_FORWARD_MARKER = path.join(homedir(), ".stado", "forwards", "brama.local");

export class EndpointNotConfiguredError extends Error {
  constructor(detail) {
    super(
      `no valid Brama address is configured on this machine: ${detail}; set BRAMA_URL, or run ` +
        "`stado service directory publish` so Stado writes the address this machine dials " +
        `to ${BRAMA_FORWARD_MARKER}`,
    );
    this.name = "EndpointNotConfiguredError";
  }
}

function configuredEndpoint(value, via) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new EndpointNotConfiguredError(`${via} must declare an absolute HTTP(S) base URL (${error.message})`);
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new EndpointNotConfiguredError(`${via} must declare an HTTP(S) base URL without credentials, query or fragment`);
  }
  return { url: url.href.replace(/\/+$/, ""), via };
}

/**
 * BRAMA_URL when the operator set it, else the address Stado's service
 * directory published for this machine (`~/.stado/forwards/brama.local`).
 * Brama's address is different on every machine, so none is written here;
 * with neither, the refusal names both ways to provide one. No provider
 * fallback.
 */
export function resolveEndpoint(env = process.env, marker = BRAMA_FORWARD_MARKER) {
  if (env.BRAMA_URL !== undefined) return configuredEndpoint(env.BRAMA_URL, "BRAMA_URL");
  let published;
  try {
    published = readFileSync(marker, "utf8").trim();
  } catch (e) {
    throw new EndpointNotConfiguredError(`BRAMA_URL is unset and ${marker} cannot be read (${e.code ?? e.message})`);
  }
  return configuredEndpoint(published, marker);
}

export class InfraDownError extends Error {
  constructor(endpoint, detail) {
    super(`brama endpoint unreachable: ${endpoint} (${detail})`);
    this.name = "InfraDownError";
    this.endpoint = endpoint;
    this.detail = detail;
  }
}

/**
 * One OpenAI-compatible chat completion answered by one required call of the
 * function `answer` names ({ name, schema }), whose parameters are its strict
 * schema; that call's arguments are returned parsed. The model infrastructure
 * being unreachable throws InfraDownError: a network-level failure (refused,
 * DNS) or a gateway-unavailability status, whose text is kept in the error.
 * An answering endpoint with any other bad status, an answer without exactly
 * that one call, or arguments that are not one JSON object throws a plain
 * Error. Never calls a provider directly, and no clock cuts the request off.
 */
export async function chatObject({ endpoint, messages, model, answer }) {
  const url = `${endpoint}/v1/chat/completions`;
  const tools = [{ type: "function", function: { name: answer.name, description: `The ${answer.name} answer, as its parameters describe it.`, strict: true, parameters: answer.schema } }];
  const toolChoice = { type: "function", function: { name: answer.name } };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools, tool_choice: toolChoice }),
    });
  } catch (e) {
    throw new InfraDownError(url, String(e.cause?.code ?? e.cause?.message ?? e.message));
  }
  let text;
  try {
    text = await res.text();
  } catch (error) {
    throw new InfraDownError(url, `reading HTTP ${res.status} response failed: ${error.cause?.message ?? error.message}`);
  }
  if (!res.ok) {
    if (INFRA_DOWN_STATUSES.includes(res.status)) throw new InfraDownError(url, `HTTP ${res.status}: ${text}`);
    throw new Error(`brama at ${url} answered HTTP ${res.status}: ${text}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`decoding brama response from ${url} (HTTP ${res.status}) failed: ${error.message}; body: ${text}`, { cause: error });
  }
  if (!Array.isArray(body?.choices)) {
    throw new Error(`brama at ${url} answered HTTP ${res.status} without a choices list; body: ${text}`);
  }
  const [choice] = body.choices;
  const calls = choice?.message?.tool_calls;
  if (!Array.isArray(calls)) {
    throw new Error(`brama at ${url} answered HTTP ${res.status} without calling ${answer.name}; body: ${text}`);
  }
  const [call, ...others] = calls;
  if (!call || others.length || call.function?.name !== answer.name || typeof call.function.arguments !== "string") {
    throw new Error(`brama at ${url} did not answer by exactly one call of ${answer.name}; body: ${text}`);
  }
  let object;
  try {
    object = JSON.parse(call.function.arguments);
  } catch (error) {
    throw new Error(`brama at ${url} called ${answer.name} with arguments that are not JSON: ${error.message}; arguments: ${call.function.arguments}`, { cause: error });
  }
  if (object === null || typeof object !== "object" || Array.isArray(object)) {
    throw new Error(`brama at ${url} called ${answer.name} with ${call.function.arguments}, not one JSON object`);
  }
  return object;
}

/** True when this module file is the CLI entrypoint. */
export function isMain(metaUrl) {
  const [, entry] = process.argv;
  return Boolean(entry) && metaUrl === pathToFileURL(path.resolve(entry)).href;
}
