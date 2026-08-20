#!/usr/bin/env node
// The five mechanical validators. Each report entry is
// { validator, pass, failures: [...] }; the process exits nonzero unless all
// five pass. Every validator is a defect the operator caught by hand:
//   claims    — every claim.evidence occurs in its named source
//   drift     — documented command lines and flags exist in the live --help
//   terms     — a term used on >=3 pages must be declared with a defining page
//   structure — the plan validates against the closed schema
//   coverage  — every brief.requiredKinds is present among page kinds
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { validatePlan } from "./schema.mjs";
import { expandPath, readJson, printReport, runCommand, fetchText, isMain } from "./lib.mjs";

/** Visit every block with its JSONPath-ish address and owning page. */
export function forEachBlock(plan, fn) {
  (plan.pages ?? []).forEach((page, pi) => {
    (page.sections ?? []).forEach((section, si) => {
      (section.blocks ?? []).forEach((block, bi) => {
        fn(block, `pages[${pi}].sections[${si}].blocks[${bi}]`, page);
      });
    });
  });
}

function resolveBinary(brief) {
  const binary = brief?.surfaces?.cli?.binary;
  return binary && existsSync(binary) ? binary : null;
}

/**
 * Command-source allowlist: only the product binary, only subcommand words
 * plus --help/--version, nothing shell-interpreted.
 * Returns { ok, args?, error? } for a plan source location string.
 */
function allowlistCommand(location, product) {
  const tokens = location.trim().split(/\s+/);
  if (tokens[0] !== product) {
    return { ok: false, error: `command must start with the product binary "${product}", got "${tokens[0]}"` };
  }
  const args = tokens.slice(1);
  let sawHelpOrVersion = false;
  for (const t of args) {
    if (t === "--help" || t === "--version") { sawHelpOrVersion = true; continue; }
    if (t.startsWith("-")) return { ok: false, error: `flag "${t}" not allowlisted (only --help/--version)` };
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(t)) return { ok: false, error: `token "${t}" not allowlisted` };
  }
  if (!sawHelpOrVersion) return { ok: false, error: "command sources must ask for --help or --version" };
  return { ok: true, args };
}

// --- claims ------------------------------------------------------------------

async function validateClaims(plan, brief, repo) {
  const failures = [];
  const binary = resolveBinary(brief);
  const product = brief?.product ?? plan.product;
  const cache = new Map();

  async function resolveSource(name) {
    if (cache.has(name)) return cache.get(name);
    const src = plan.sources?.[name];
    let out;
    if (!src) {
      out = { ok: false, error: `source "${name}" is not in plan.sources` };
    } else if (src.kind === "file") {
      const abs = expandPath(src.location, repo);
      out = existsSync(abs)
        ? { ok: true, text: readFileSync(abs, "utf8") }
        : { ok: false, error: `file not found: ${abs}` };
    } else if (src.kind === "command") {
      const allowed = allowlistCommand(src.location, product);
      if (!allowed.ok) out = { ok: false, error: allowed.error };
      else if (!binary) out = { ok: false, error: `no probed cli binary in brief for product "${product}"` };
      else {
        const run = await runCommand(binary, allowed.args, { timeoutMs: 15000, cwd: repo });
        out = run.ok ? { ok: true, text: run.stdout } : { ok: false, error: `command failed: ${run.error}` };
      }
    } else if (src.kind === "url") {
      const res = await fetchText(src.location, 15000);
      out = res.ok ? { ok: true, text: res.text } : { ok: false, error: `fetch failed: ${res.error}` };
    } else {
      out = { ok: false, error: `unknown source kind "${src.kind}"` };
    }
    cache.set(name, out);
    return out;
  }

  const checks = [];
  forEachBlock(plan, (block, addr, page) => checks.push({ block, addr, page }));
  for (const { block, addr, page } of checks) {
    const claim = block.claim;
    if (!claim?.source || !claim?.evidence) continue; // structure validator owns shape defects
    const src = await resolveSource(claim.source);
    if (!src.ok) {
      failures.push({ block: addr, page: page.slug, source: claim.source, message: src.error });
      continue;
    }
    const found = claim.evidenceIsRegex
      ? new RegExp(claim.evidence, "m").test(src.text)
      : src.text.includes(claim.evidence);
    if (!found) {
      failures.push({
        block: addr,
        page: page.slug,
        source: claim.source,
        message: `evidence ${claim.evidenceIsRegex ? "regex" : "string"} does not occur in source: ${JSON.stringify(claim.evidence)}`,
      });
    }
  }
  return failures;
}

// --- drift ---------------------------------------------------------------------

async function validateDrift(plan, brief, repo) {
  const failures = [];
  const product = brief?.product ?? plan.product;
  const binary = resolveBinary(brief);
  const helpCache = new Map();

  async function helpFor(cmdPath) {
    const key = cmdPath.join(" ");
    if (!helpCache.has(key)) {
      helpCache.set(key, await runCommand(binary, [...cmdPath, "--help"], { timeoutMs: 15000, cwd: repo }));
    }
    return helpCache.get(key);
  }

  const checks = [];
  forEachBlock(plan, (block, addr, page) => {
    const text = block.type === "code" ? block.code?.code : undefined;
    if (!text) return;
    const firstLine = text.trim().split("\n")[0].trim();
    const tokens = firstLine.split(/\s+/);
    if (tokens[0] !== product) return; // not a product command block
    checks.push({ addr, page, text, tokens });
  });

  for (const { addr, page, text, tokens } of checks) {
    if (!binary) {
      failures.push({ block: addr, page: page.slug, message: `code documents "${product}" but brief has no probed cli binary` });
      continue;
    }
    const cmdPath = [];
    for (const t of tokens.slice(1)) {
      if (/^[a-z0-9][a-z0-9_-]*$/.test(t)) cmdPath.push(t);
      else break;
    }
    const usage = [product, ...cmdPath].join(" ");
    const help = await helpFor(cmdPath);
    if (!help.ok) {
      failures.push({ block: addr, page: page.slug, message: `"${usage}" does not answer --help: ${help.error}` });
      continue;
    }
    const flags = [...new Set([...text.matchAll(/(^|\s)(--[a-z][a-z0-9-]*)/g)].map((m) => m[2]))];
    for (const flag of flags) {
      if (!help.stdout.includes(flag)) {
        failures.push({ block: addr, page: page.slug, message: `flag "${flag}" does not appear in "${usage} --help"` });
      }
    }
  }
  return failures;
}

// --- terms ------------------------------------------------------------------

// Generic English / documentation words that are not product concepts.
const STOPWORDS = new Set(`
about above after again against almost already also always another answer
answers anything appear appears back because been before begin being below
between both cannot case cases change changes come comes could does done down
each either else enough even every everything exactly example examples exit
exits exist exists first found from full gets give gives goes have haves having
here holds inside instead into itself just keep keeps kind kinds last later
least left less like line lines list lists longer look looks made make makes
many may mean means might more most much must name names need needs never next
none nothing often once ones only onto other others over own page pages part
parts path paths per place plus print prints rather read reads real reason
right runs said same says section sections see seen sets shall shape shell
should show shows side simple since small some something state states still
such take takes tell tells text than that thats their them then there these
they thing things this those three through time times today together tool
tools turn turns under until upon used uses using value values very want wants
ways well were what when where whether which while whole whose will with
within without word words work works would write writes your yours
`.trim().split(/\s+/));

function pageProse(page) {
  const parts = [page.title ?? "", page.description ?? ""];
  for (const section of page.sections ?? []) {
    parts.push(section.title ?? "");
    for (const block of section.blocks ?? []) {
      if (block.text) parts.push(block.text);
      if (block.items) parts.push(...block.items);
      if (block.callout) parts.push(block.callout.title ?? "", block.callout.text ?? "");
      if (block.table) {
        parts.push(block.table.caption ?? "", ...(block.table.columns ?? []));
        for (const row of block.table.rows ?? []) parts.push(...row);
      }
      // code blocks are not rendered prose; drift owns them
    }
  }
  return parts.join("\n").toLowerCase();
}

function validateTerms(plan, brief) {
  const failures = [];
  const product = (brief?.product ?? plan.product ?? "").toLowerCase();
  const slugs = new Set((plan.pages ?? []).map((p) => p.slug));

  // Every declared term must be defined on a page that exists.
  const declaredWords = new Set();
  for (const t of plan.terms ?? []) {
    for (const w of t.term.toLowerCase().split(/[^a-z0-9-]+/)) if (w) declaredWords.add(w);
    if (!slugs.has(t.definedOn)) {
      failures.push({ term: t.term, message: `definedOn "${t.definedOn}" is not an existing page slug` });
    }
  }
  const covered = (w) =>
    declaredWords.has(w) || declaredWords.has(`${w}s`) || (w.endsWith("s") && declaredWords.has(w.slice(0, -1)));

  // Any word recurring on >=3 pages must be a declared term.
  const usage = new Map();
  for (const page of plan.pages ?? []) {
    const words = new Set(pageProse(page).match(/[a-z][a-z-]{3,}/g) ?? []);
    for (const w of words) {
      if (w === product || STOPWORDS.has(w)) continue;
      if (!usage.has(w)) usage.set(w, []);
      usage.get(w).push(page.slug);
    }
  }
  for (const [word, pages] of usage) {
    if (pages.length >= 3 && !covered(word)) {
      failures.push({
        term: word,
        pages,
        message: `"${word}" is used on ${pages.length} pages but is not declared in plan.terms`,
      });
    }
  }
  return failures;
}

// --- structure / coverage ------------------------------------------------------

function validateStructure(plan) {
  return validatePlan(plan).map((e) => ({ path: e.path, message: e.message }));
}

function validateCoverage(plan, brief) {
  const kinds = new Set((plan.pages ?? []).map((p) => p.kind));
  return (brief?.requiredKinds ?? [])
    .filter((k) => !kinds.has(k))
    .map((kind) => ({ kind, message: `required page kind "${kind}" is missing from the plan` }));
}

// --- runner -------------------------------------------------------------------

export async function runValidators({ plan, brief, repo }) {
  const validators = [
    { validator: "claims", failures: await validateClaims(plan, brief, repo) },
    { validator: "drift", failures: await validateDrift(plan, brief, repo) },
    { validator: "terms", failures: validateTerms(plan, brief) },
    { validator: "structure", failures: validateStructure(plan) },
    { validator: "coverage", failures: validateCoverage(plan, brief) },
  ].map((v) => ({ validator: v.validator, pass: v.failures.length === 0, failures: v.failures }));
  return { ok: validators.every((v) => v.pass), validators };
}

async function main() {
  const { values } = parseArgs({
    options: { plan: { type: "string" }, brief: { type: "string" }, repo: { type: "string" } },
  });
  if (!values.plan || !values.brief) {
    printReport({ error: "usage", detail: "node src/validate.mjs --plan plan.json --brief brief.json [--repo path]" });
    process.exit(2);
  }
  const plan = readJson(values.plan);
  const brief = readJson(values.brief);
  const repo = expandPath(values.repo ?? brief.repo ?? process.cwd());
  const report = await runValidators({ plan, brief, repo });
  printReport(report);
  process.exit(report.ok ? 0 : 1);
}

if (isMain(import.meta.url)) await main();
