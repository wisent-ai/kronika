#!/usr/bin/env node
// The five validators. Each report entry is
// { validator, pass, failures: [...] }; the process exits nonzero unless all
// five pass. Every validator is a defect the operator caught by hand:
//   claims    — every claim.evidence occurs in its named source
//   drift     — documented command lines and flags exist in the live --help
//   terms     — a word used on multiple pages that Brama judges a product concept
//               must be declared with a defining page (BRAMA_URL or the
//               service directory marker; unreachable fails the validator)
//   structure — the plan validates against the closed schema
//   coverage  — every brief.requiredKinds is present among page kinds, and
//               every command the binary's --help advertises has a cli-reference
//               page whose slug is `cli/<command>` or below it (cli.md rule 17)
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { validatePlan } from "../schema.mjs";
import {
  expandPath, readJson, printReport, parseCommand, runCommand, fetchText, isMain, resolveEndpoint, EXIT_STAGE_FAILED,
} from "../lib.mjs";
import { validateTerms } from "../validators/terms.mjs";
import { validateCoverage } from "../validators/coverage.mjs";
import { parseCommandList } from "./detect.mjs";

/**
 * Visit every block with its JSONPath-ish address and owning page. A plan
 * missing a list holds no blocks there; the structure validator reports it.
 */
export function forEachBlock(plan, fn) {
  for (const [pi, page] of Object.entries({ ...plan.pages })) {
    for (const [si, section] of Object.entries({ ...page.sections })) {
      for (const [bi, block] of Object.entries({ ...section.blocks })) {
        fn(block, `pages[${pi}].sections[${si}].blocks[${bi}]`, page);
      }
    }
  }
}

/** The probed CLI binary the brief names, when it exists on this machine. */
function resolveBinary(brief) {
  const binary = brief?.surfaces?.cli?.binary;
  if (binary && existsSync(binary)) return binary;
  return undefined;
}

/**
 * Command-source allowlist: only the product binary, only subcommand words
 * plus --help/--version, nothing shell-interpreted.
 * Returns { ok, args?, error? } for a plan source location string.
 */
function allowlistCommand(location, product) {
  const [head, ...args] = location.trim().split(/\s+/);
  if (head !== product) {
    return { ok: false, error: `command must start with the product binary "${product}", got "${head}"` };
  }
  let sawHelpOrVersion = false;
  for (const t of args) {
    if (t === "--help" || t === "--version") { sawHelpOrVersion = true; continue; }
    if (t.startsWith("-")) return { ok: false, error: `flag "${t}" not allowlisted (only --help/--version)` };
    if (!/^[a-z\d][a-z\d_-]*$/.test(t)) return { ok: false, error: `token "${t}" not allowlisted` };
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
    // Each invocation has its own help context; flags on a later command
    // cannot be checked against the first command's help.
    for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
      const command = line.trim();
      const [head, ...words] = command.split(/\s+/);
      if (head !== product) continue;
      checks.push({ addr, page, text: command, words });
    }
  });

  for (const { addr, page, text, words } of checks) {
    if (!binary) {
      failures.push({ block: addr, page: page.slug, message: `code documents "${product}" but brief has no probed cli binary` });
      continue;
    }
    const cmdPath = [];
    let help = await helpFor(cmdPath);
    let unresolved = false;
    for (const token of words) {
      if (!help.ok || token.startsWith("-")) break;
      // A leaf command's following words are operands, not subcommands.
      if (!/^Commands:\r?$/m.test(help.stdout)) break;
      const commands = parseCommandList(help.stdout);
      if (!commands.includes(token)) {
        failures.push({
          block: addr,
          page: page.slug,
          message: `"${[product, ...cmdPath].join(" ")} --help" does not advertise subcommand ${JSON.stringify(token)}`,
        });
        unresolved = true;
        break;
      }
      cmdPath.push(token);
      help = await helpFor(cmdPath);
    }
    if (unresolved) continue;
    const usage = [product, ...cmdPath].join(" ");
    if (!help.ok) {
      failures.push({ block: addr, page: page.slug, message: `"${usage}" does not answer --help: ${help.error}` });
      continue;
    }
    const flagPattern = /(?:^|\s)(?<flag>--[a-z][a-z\d-]*)/g;
    const flags = [...new Set(Array.from(text.matchAll(flagPattern), (m) => m.groups.flag))];
    const reportedFlags = new Set(Array.from(help.stdout.matchAll(flagPattern), (m) => m.groups.flag));
    for (const flag of flags) {
      if (!reportedFlags.has(flag)) {
        failures.push({ block: addr, page: page.slug, message: `flag "${flag}" does not appear in "${usage} --help"` });
      }
    }
  }
  return failures;
}


// --- structure / coverage ------------------------------------------------------

function validateStructure(plan) {
  return validatePlan(plan).map((e) => ({ path: e.path, message: e.message }));
}


// --- runner -------------------------------------------------------------------

/**
 * `endpoint` is the Brama address the terms judgement asks (under Brama's
 * own decision alias); without one it is resolved (BRAMA_URL or the service
 * directory marker) only when there is something to judge. A validator that
 * throws fails with its error as its one failure.
 */
export async function runValidators({ plan, brief, repo, endpoint }) {
  const judge = () => ({ endpoint: endpoint ?? resolveEndpoint() });
  const capture = async (validator, run) => {
    let failures;
    try {
      failures = await run();
    } catch (error) {
      failures = [{ message: `${validator} validator failed: ${error instanceof Error ? error.message : String(error)}` }];
    }
    return { validator, pass: !failures.length, failures };
  };
  const validators = [
    await capture("claims", () => validateClaims(plan, brief, repo)),
    await capture("drift", () => validateDrift(plan, brief, repo)),
    await capture("terms", () => validateTerms(plan, brief, judge)),
    await capture("structure", () => validateStructure(plan)),
    await capture("coverage", () => validateCoverage(plan, brief, repo, resolveBinary(brief))),
  ];
  return { ok: validators.every((v) => v.pass), validators };
}

async function main() {
  const { values } = parseCommand(
    "node src/stages/validate.mjs --plan plan.json --brief brief.json [--repo path] [--text]",
    { plan: { type: "string" }, brief: { type: "string" }, repo: { type: "string" } },
    { positionals: [], required: "plan brief".split(" ") },
  );
  const plan = readJson(values.plan);
  const brief = readJson(values.brief);
  const repo = expandPath(values.repo ?? brief.repo ?? process.cwd());
  const report = await runValidators({ plan, brief, repo });
  printReport(report);
  if (!report.ok) process.exit(EXIT_STAGE_FAILED);
  process.exit();
}

if (isMain(import.meta.url)) await main();
