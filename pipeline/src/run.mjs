#!/usr/bin/env node
// Pipeline orchestrator: detect -> (author | load plan) -> validate -> judge
// -> emit. Stops at the first failing stage; prints one final JSON report.
// Exit codes: 0 all green, 1 stage failed, 69 model infrastructure down.
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detect } from "./detect.mjs";
import { runValidators } from "./validate.mjs";
import { authorPlan } from "./author.mjs";
import { emitPlan } from "./emit.mjs";
import { expandPath, readJson, printReport, isMain, resolveEndpoint, InfraDownError } from "./lib.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sources: { type: "string" },
      plan: { type: "string" },
      out: { type: "string" },

      model: { type: "string", default: "default" },
    },
  });
  if (positionals.length !== 1 || !values.sources) {
    printReport({
      error: "usage",
      detail: "node src/run.mjs <productRepo> --sources <file> [--plan <file>] [--out <dir>]",
    });
    process.exit(2);
  }

  const stages = [];
  const finish = (ok, code = ok ? 0 : 1) => {
    printReport({ ok, stages });
    process.exit(code);
  };

  // 1. detect
  const brief = await detect(positionals[0], values.sources);
  stages.push({ stage: "detect", ok: brief.ok, brief });
  if (!brief.ok) finish(false);

  // 2. author, or load an existing plan (validation+emission without a model)
  let plan;
  if (values.plan) {
    plan = readJson(values.plan);
    stages.push({ stage: "plan", ok: true, mode: "loaded", path: expandPath(values.plan) });
  } else {
    const endpoint = resolveEndpoint();
    const sources = readJson(expandPath(values.sources));
    try {
      const authored = await authorPlan({ brief, sources, repo: brief.repo, model: values.model, endpoint });
      if (authored.schemaErrors.length > 0) {
        stages.push({ stage: "author", ok: false, error: "invalid_plan", schemaErrors: authored.schemaErrors });
        finish(false);
      }
      plan = authored.plan;
      const planPath = path.resolve("plan.json");
      writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
      stages.push({ stage: "author", ok: true, mode: "authored", path: planPath, endpoint: endpoint.url });
    } catch (e) {
      if (e instanceof InfraDownError) {
        stages.push({ stage: "author", ok: false, error: "infra_down", detail: e.message, endpoint: e.endpoint, resolvedVia: endpoint.via });
        finish(false, 69);
      }
      stages.push({ stage: "author", ok: false, error: "author_failed", detail: e.message });
      finish(false);
    }
  }

  // 3. validate
  const validation = await runValidators({ plan, brief, repo: brief.repo });
  stages.push({ stage: "validate", ok: validation.ok, report: validation });
  if (!validation.ok) finish(false);


  // 4. emit
  if (values.out) {
    const outDir = expandPath(values.out);
    const { docPages, docsNav, module } = emitPlan(plan);
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "docs.ts");
    writeFileSync(outFile, module);
    stages.push({
      stage: "emit",
      ok: true,
      out: outFile,
      pages: docPages.map((p) => p.slug),
      nav: docsNav.map((g) => ({ label: g.label, items: g.items.length })),
    });
  } else {
    stages.push({ stage: "emit", ok: true, skipped: true, note: "no --out directory given" });
  }

  finish(true);
}

if (isMain(import.meta.url)) await main();
