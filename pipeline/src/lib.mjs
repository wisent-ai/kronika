// Shared helpers for docs-cli modules. Node builtins only.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// A gateway that answers with one of these is down, not refusing the request.
const INFRA_DOWN_STATUSES = [502, 503, 504];

export function expandPath(p, base = process.cwd()) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return path.resolve(base, p);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Parse one entry point's command line the same way everywhere: `--help`
 * prints the usage and exits 0, `--text` is always accepted, and a command
 * line parseArgs refuses (unknown option, missing value) or that lacks a
 * `required` option exits 2 with the reason and the usage (cli.md rules 10,
 * 11). Returns parseArgs's `{ values, positionals }`.
 */
export function parseCommand(usage, options, { positionals = 0, required = [] } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: positionals > 0,
      options: { ...options, text: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } },
    });
  } catch (error) {
    printReport({ error: "usage", detail: `${error.message}; usage: ${usage}` });
    process.exit(2);
  }
  if (parsed.values.help) {
    process.stdout.write(`usage: ${usage}\n\nResults print as JSON; --text prints the same report as one path: value line per field.\n`);
    process.exit(0);
  }
  const missing = required.filter((name) => !parsed.values[name]);
  if (parsed.positionals.length !== positionals || missing.length) {
    const reason = missing.length ? `missing --${missing.join(", --")}` : `expected ${positionals} positional argument(s)`;
    printReport({ error: "usage", detail: `${reason}; usage: ${usage}` });
    process.exit(2);
  }
  return parsed;
}

// JSON for machines; with --text one `path: value` line per field of the
// same report (cli.md rule 13).
export function printReport(report) {
  if (!process.argv.includes("--text")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
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

export function die(report, code = 1) {
  printReport(report);
  process.exit(code);
}

/**
 * Run a binary directly (no shell). Resolves with { ok, code, stdout, stderr, error }
 * when it exits. Its standard input is closed at once, so a binary that would
 * read a prompt sees end of input and answers instead of waiting.
 */
export function runCommand(file, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderder) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderder ?? "",
          error: error ? error.message.split("\n")[0] : undefined,
        });
      },
    );
    child.stdin?.end();
  });
}

/** Fetch a URL as text. Resolves { ok, status?, text?, error? } on the answer or the connection failure. */
export async function fetchText(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, error: String(e.cause?.code ?? e.message) };
  }
}

// --- Model endpoint (Brama) ------------------------------------------------

/** Where `stado service directory publish` writes the address this machine dials for Brama. */
export const BRAMA_FORWARD_MARKER = path.join(homedir(), ".stado", "forwards", "brama.local");

export class EndpointNotConfiguredError extends Error {
  constructor(detail) {
    super(
      `no Brama address is configured on this machine: ${detail}; set BRAMA_URL, or run ` +
        "`stado service directory publish` so Stado writes the address this machine dials " +
        `to ${BRAMA_FORWARD_MARKER}`,
    );
    this.name = "EndpointNotConfiguredError";
  }
}

/**
 * BRAMA_URL when the operator set it, else the address Stado's service
 * directory published for this machine (`~/.stado/forwards/brama.local`).
 * Brama's address is different on every machine, so none is written here;
 * with neither, the refusal names both ways to provide one. No provider
 * fallback.
 */
export function resolveEndpoint(env = process.env, marker = BRAMA_FORWARD_MARKER) {
  if (env.BRAMA_URL) return { url: env.BRAMA_URL.replace(/\/+$/, ""), via: "BRAMA_URL" };
  let published;
  try {
    published = readFileSync(marker, "utf8").trim();
  } catch (e) {
    throw new EndpointNotConfiguredError(`BRAMA_URL is unset and ${marker} cannot be read (${e.code ?? e.message})`);
  }
  if (!/^https?:\/\//.test(published)) {
    throw new EndpointNotConfiguredError(`BRAMA_URL is unset and ${marker} holds no http(s) address`);
  }
  return { url: published.replace(/\/+$/, ""), via: marker };
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
 * One OpenAI-compatible chat completion. The model infrastructure being
 * unreachable throws InfraDownError: a network-level failure (refused, DNS)
 * or the resolver adapter answering a gateway-unavailability status
 * (502/503/504 — the adapter is up but Brama behind it is not). An answering
 * endpoint with any other bad status throws a plain Error. Never calls a
 * provider directly, and no clock cuts the request off.
 */
export async function chatComplete({ endpoint, messages, model = "default" }) {
  const url = `${endpoint}/v1/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0 }),
    });
  } catch (e) {
    throw new InfraDownError(url, String(e.cause?.code ?? e.cause?.message ?? e.message));
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400).trim();
    if (INFRA_DOWN_STATUSES.includes(res.status)) throw new InfraDownError(url, `HTTP ${res.status}: ${body}`);
    throw new Error(`brama answered HTTP ${res.status}: ${body}`);
  }
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("brama answer had no choices[0].message.content");
  return content;
}

/** True when this module file is the CLI entrypoint. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}
