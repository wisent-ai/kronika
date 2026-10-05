#!/usr/bin/env node
// The five validators. Each report entry is
// { validator, pass, failures: [...] }; the process exits nonzero unless all
// five pass. Every validator is a defect the operator caught by hand:
//   claims    — every claim.evidence occurs in its named source
//   drift     — documented command lines and flags exist in the live --help
//   terms     — a word used on >=3 pages that Brama judges a product concept
//               must be declared with a defining page (BRAMA_URL or the
//               service directory marker; unreachable fails the validator)
//   structure — the plan validates against the closed schema
//   coverage  — every brief.requiredKinds is present among page kinds, and
//               every command the binary's --help advertises has a cli-reference
//               page whose slug is `cli/<command>` or below it (cli.md rule 17)
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { validatePlan } from "../schema.mjs";
import { expandPath, readJson, printReport, parseCommand, runCommand, fetchText, isMain, resolveEndpoint, chatComplete } from "../lib.mjs";

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
        const run = await runCommand(binary, allowed.args, { cwd: repo });
        out = run.ok ? { ok: true, text: run.stdout } : { ok: false, error: `command failed: ${run.error}` };
      }
    } else if (src.kind === "url") {
      const res = await fetchText(src.location);
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
      helpCache.set(key, await runCommand(binary, [...cmdPath, "--help"], { cwd: repo }));
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

/**
 * Which of `words` name a concept of this product that a reader has to learn,
 * as opposed to ordinary English, asked of a model through Brama. A built-in
 * stopword list decided this before, so every generic word it lacked was
 * demanded as a term and every product word it happened to hold was waved
 * through. Throws when Brama cannot answer or answers outside the words asked.
 */
async function productConcepts(words, product, { endpoint, model }) {
  const messages = [
    {
      role: "system",
      content:
        "You review the documentation of one software product. For each word given, decide whether it names a concept of " +
        "that product a reader has to learn (a component, command, resource or idea specific to it) or is ordinary " +
        "English vocabulary. Answer with JSON only: {\"concepts\": [the words that are product concepts]}.",
    },
    { role: "user", content: JSON.stringify({ product, words }) },
  ];
  const content = await chatComplete({ endpoint: endpoint.url, messages, model });
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const answer = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (!Array.isArray(answer?.concepts) || answer.concepts.some((w) => !words.includes(w))) {
    throw new Error(`brama's term judgement is not a list drawn from the words asked: ${text.slice(0, 400)}`);
  }
  return new Set(answer.concepts);
}

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

async function validateTerms(plan, brief, judge) {
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

  // A word on more than one page that names a product concept must be a
  // declared term; whether it names one is the model's judgement, for every
  // such word, short or long.
  const usage = new Map();
  for (const page of plan.pages ?? []) {
    const words = new Set(pageProse(page).match(/[a-z][a-z-]*/g) ?? []);
    for (const w of words) {
      if (w === product) continue;
      if (!usage.has(w)) usage.set(w, []);
      usage.get(w).push(page.slug);
    }
  }
  const recurring = [...usage].filter(([, pages]) => pages.length > 1).filter(([word]) => !covered(word));
  if (recurring.length === 0) return failures;
  let concepts;
  try {
    concepts = await productConcepts(recurring.map(([word]) => word), product, judge());
  } catch (e) {
    failures.push({ message: `recurring words could not be judged: ${e.message}` });
    return failures;
  }
  for (const [word, pages] of recurring) {
    if (concepts.has(word)) {
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
  const pages = plan.pages ?? [];
  const kinds = new Set(pages.map((p) => p.kind));
  const failures = (brief?.requiredKinds ?? [])
    .filter((k) => !kinds.has(k))
    .map((kind) => ({ kind, message: `required page kind "${kind}" is missing from the plan` }));
  // The binary's own command list, read by detect from `--help`; a command
  // with no page of its own is a published promise nobody can read about.
  const commands = brief?.surfaces?.cli?.commands ?? [];
  const slugs = pages.filter((p) => p.kind === "cli-reference").map((p) => p.slug);
  for (const command of commands) {
    if (command === "help") continue;
    const documented = slugs.some((slug) => slug === `cli/${command}` || slug.startsWith(`cli/${command}/`));
    if (!documented) {
      failures.push({ command, message: `command "${command}" is in the binary's --help but no cli-reference page has slug "cli/${command}"` });
    }
  }
  return failures;
}

// --- runner -------------------------------------------------------------------

/**
 * `endpoint` and `model` are the Brama address and alias the terms judgement
 * asks; without an endpoint it is resolved (BRAMA_URL or the service
 * directory marker) only when there is something to judge.
 */
export async function runValidators({ plan, brief, repo, endpoint, model = "default" }) {
  const judge = () => ({ endpoint: endpoint ?? resolveEndpoint(), model });
  const validators = [
    { validator: "claims", failures: await validateClaims(plan, brief, repo) },
    { validator: "drift", failures: await validateDrift(plan, brief, repo) },
    { validator: "terms", failures: await validateTerms(plan, brief, judge) },
    { validator: "structure", failures: validateStructure(plan) },
    { validator: "coverage", failures: validateCoverage(plan, brief) },
  ].map((v) => ({ validator: v.validator, pass: v.failures.length === 0, failures: v.failures }));
  return { ok: validators.every((v) => v.pass), validators };
}

async function main() {
  const { values } = parseCommand(
    "node src/stages/validate.mjs --plan plan.json --brief brief.json [--repo path] [--text]",
    { plan: { type: "string" }, brief: { type: "string" }, repo: { type: "string" } },
    { required: "plan brief".split(" ") },
  );
  const plan = readJson(values.plan);
  const brief = readJson(values.brief);
  const repo = expandPath(values.repo ?? brief.repo ?? process.cwd());
  const report = await runValidators({ plan, brief, repo });
  printReport(report);
  process.exit(report.ok ? 0 : 1);
}

if (isMain(import.meta.url)) await main();
