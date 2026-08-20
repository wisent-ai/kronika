#!/usr/bin/env node
// Surface detection: probe the sources a product repo declares in
// docs-sources.json and compute brief.json — the page-set formula from the
// README. Never invents a surface; only declared, probed surfaces count.
//
// The completion-gate formula:
//   always                       -> overview (the support tail is an emission
//                                   concern: emit orders support pages last)
//   cli binary answers --help    -> quick-start, cli-reference
//   http route file readable     -> api-reference
//   configuration doc exists     -> config-reference
//   CHANGELOG exists             -> changelog; + migration iff breaking entries
//   declared limits/quotas exist -> limits
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expandPath, readJson, printReport, runCommand, isMain } from "./lib.mjs";

function parseCommandList(helpText) {
  // clap layout: a "Commands:" header, then "  <name>  <description>" lines.
  const m = helpText.match(/^Commands:\n([\s\S]*?)(?:\n\n|\n[A-Z])/m);
  if (!m) return [];
  const names = [];
  for (const line of m[1].split("\n")) {
    const t = line.match(/^ {2}([a-z][a-z0-9-]*)\b/);
    if (t) names.push(t[1]);
  }
  return names;
}

function probeFile(repo, rel) {
  const abs = expandPath(rel, repo);
  return { path: abs, ok: existsSync(abs) };
}

export async function detect(productRepo, sourcesFile) {
  const repo = expandPath(productRepo);
  const declared = readJson(expandPath(sourcesFile));
  if (typeof declared.product !== "string" || !declared.product) {
    throw new Error('docs-sources.json must declare "product"');
  }
  const product = declared.product;
  const surfaces = {};
  const problems = [];
  const requiredKinds = ["overview"];

  // CLI binary surface.
  if (declared.binary) {
    const binary = expandPath(declared.binary, repo);
    const s = { declared: true, binary, ok: false };
    const ver = await runCommand(binary, ["--version"], { timeoutMs: 10000, cwd: repo });
    const help = await runCommand(binary, ["--help"], { timeoutMs: 10000, cwd: repo });
    if (ver.ok && help.ok) {
      s.ok = true;
      s.version = ver.stdout.trim().split("\n")[0].trim().split(/\s+/).pop();
      s.commands = parseCommandList(help.stdout);
      requiredKinds.push("quick-start", "cli-reference");
    } else {
      s.error = ver.ok ? `--help failed: ${help.error}` : `--version failed: ${ver.error}`;
      problems.push(`cli: ${binary}: ${s.error}`);
    }
    surfaces.cli = s;
  } else {
    surfaces.cli = { declared: false };
  }

  // HTTP route table surface.
  if (declared.routes) {
    const p = probeFile(repo, declared.routes);
    const s = { declared: true, ...p };
    if (p.ok) {
      const header = readFileSync(p.path, "utf8");
      s.routes = (header.match(/^\/\/! (GET|PUT|POST|DELETE|PATCH)\b.*$/gm) || []).length;
      requiredKinds.push("api-reference");
    } else {
      problems.push(`routes: ${p.path}: not readable`);
    }
    surfaces.api = s;
  } else {
    surfaces.api = { declared: false };
  }

  // Configuration document surface.
  if (declared.config) {
    const p = probeFile(repo, declared.config);
    surfaces.config = { declared: true, ...p };
    if (p.ok) requiredKinds.push("config-reference");
    else problems.push(`config: ${p.path}: not readable`);
  } else {
    surfaces.config = { declared: false };
  }

  // Changelog surface (+ migration iff breaking entries exist).
  if (declared.changelog) {
    const p = probeFile(repo, declared.changelog);
    const s = { declared: true, ...p };
    if (p.ok) {
      s.breaking = /breaking/i.test(readFileSync(p.path, "utf8"));
      requiredKinds.push("changelog");
      if (s.breaking) requiredKinds.push("migration");
    } else {
      problems.push(`changelog: ${p.path}: not readable`);
    }
    surfaces.changelog = s;
  } else {
    surfaces.changelog = { declared: false };
  }

  // Declared limits/quotas surface.
  if (declared.limits) {
    const p = probeFile(repo, declared.limits);
    surfaces.limits = { declared: true, ...p };
    if (p.ok) requiredKinds.push("limits");
    else problems.push(`limits: ${p.path}: not readable`);
  } else {
    surfaces.limits = { declared: false };
  }

  // Plain evidence documents (author excerpts; not page-set surfaces).
  const docs = {};
  for (const [name, rel] of Object.entries(declared.docs ?? {})) {
    const p = probeFile(repo, rel);
    docs[name] = p;
    if (!p.ok) problems.push(`docs.${name}: ${p.path}: not readable`);
  }

  return {
    ok: problems.length === 0,
    product,
    version: surfaces.cli.version ?? "unknown",
    repo,
    surfaces,
    docs,
    requiredKinds,
    problems,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { sources: { type: "string" }, out: { type: "string" } },
  });
  if (positionals.length !== 1 || !values.sources) {
    printReport({ error: "usage", detail: "node src/detect.mjs <productRepo> --sources <docs-sources.json> [--out brief.json]" });
    process.exit(2);
  }
  const brief = await detect(positionals[0], values.sources);
  if (values.out) writeFileSync(values.out, JSON.stringify(brief, null, 2) + "\n");
  printReport(brief);
  process.exit(brief.ok ? 0 : 1);
}

if (isMain(import.meta.url)) await main();
