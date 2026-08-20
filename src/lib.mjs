// Shared helpers for docs-cli modules. Node builtins only.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function expandPath(p, base = process.cwd()) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return path.resolve(base, p);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function printReport(report) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

export function die(report, code = 1) {
  printReport(report);
  process.exit(code);
}

/** Run a binary directly (no shell). Resolves with { ok, code, stdout, stderr, error }. */
export function runCommand(file, args, { timeoutMs = 15000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, cwd, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
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
  });
}

/** Fetch a URL as text with a hard timeout. Resolves { ok, status?, text?, error? }. */
export async function fetchText(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(e.cause?.code ?? e.message) };
  } finally {
    clearTimeout(t);
  }
}

// --- Model endpoint (Brama) ------------------------------------------------

export const LOCAL_BRAMA_ADAPTER = "http://127.0.0.1:17601";

/** BRAMA_URL env, else the local Stado resolver's brama adapter. No provider fallback. */
export function resolveEndpoint(env = process.env) {
  if (env.BRAMA_URL) return { url: env.BRAMA_URL.replace(/\/+$/, ""), via: "BRAMA_URL" };
  return { url: LOCAL_BRAMA_ADAPTER, via: "local resolver brama adapter (BRAMA_URL unset)" };
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
 * unreachable throws InfraDownError: a network-level failure (refused, DNS,
 * timeout) or the resolver adapter answering a gateway-unavailability status
 * (502/503/504 — the adapter is up but Brama behind it is not). An answering
 * endpoint with any other bad status throws a plain Error. Never calls a
 * provider directly.
 */
export async function chatComplete({ endpoint, messages, model = "default", timeoutMs = 180000 }) {
  const url = `${endpoint}/v1/chat/completions`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0 }),
      signal: ctl.signal,
    });
  } catch (e) {
    const detail = e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(e.cause?.code ?? e.cause?.message ?? e.message);
    throw new InfraDownError(url, detail);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400).trim();
    if ([502, 503, 504].includes(res.status)) throw new InfraDownError(url, `HTTP ${res.status}: ${body}`);
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
