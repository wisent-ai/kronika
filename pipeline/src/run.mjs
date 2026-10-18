#!/usr/bin/env node
// Pipeline orchestrator: detect -> (author | load plan) -> validate -> judge
// -> emit. Stops at the first failing stage; prints one final report (JSON,
// or --text). Exit statuses: success when all are green, EXIT_STAGE_FAILED
// when a stage failed, EXIT_USAGE on a usage error, EXIT_BRAMA_DOWN when the
// model infrastructure is down.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detect } from "./stages/detect.mjs";
import { runValidators } from "./stages/validate.mjs";
import { authorPlan } from "./stages/author.mjs";
import { emitPlan } from "./stages/emit.mjs";
import {
  expandPath, readJson, printReport, parseCommand, isMain, resolveEndpoint, InfraDownError, EndpointNotConfiguredError,
  EXIT_STAGE_FAILED, EXIT_BRAMA_DOWN,
} from "./lib.mjs";

const USAGE = "kronika-site <productRepo> --sources <file> [--plan <file>] [--out <dir>] [--model <selector>] [--text]";

async function main() {
  const { values, positionals } = parseCommand(USAGE, {
    sources: { type: "string" },
    plan: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "default" },
  }, { positionals: ["productRepo"], required: ["sources"] });

  const stages = [];
  const finish = (ok, code) => {
    printReport({ ok, stages });
    process.exit(code);
  };
  const fail = () => finish(false, EXIT_STAGE_FAILED);

  // 1. detect
  const brief = await detect(positionals.productRepo, values.sources);
  stages.push({ stage: "detect", ok: brief.ok, brief });
  if (!brief.ok) fail();

  // 2. author, or load an existing plan (validation+emission without a model)
  let plan;
  if (values.plan) {
    plan = readJson(values.plan);
    stages.push({ stage: "plan", ok: true, mode: "loaded", path: expandPath(values.plan) });
  } else {
    let endpoint;
    try {
      endpoint = resolveEndpoint();
    } catch (e) {
      if (!(e instanceof EndpointNotConfiguredError)) throw e;
      stages.push({ stage: "author", ok: false, error: "not_configured", detail: e.message });
      fail();
    }
    try {
      const authored = await authorPlan({ brief, repo: brief.repo, model: values.model, endpoint });
      if (authored.schemaErrors.length) {
        stages.push({ stage: "author", ok: false, error: "invalid_plan", schemaErrors: authored.schemaErrors });
        fail();
      }
      plan = authored.plan;
      const planPath = path.resolve("plan.json");
      writeFileSync(planPath, JSON.stringify(plan, null, "  ") + "\n");
      stages.push({ stage: "author", ok: true, mode: "authored", path: planPath, endpoint: endpoint.url });
    } catch (e) {
      if (e instanceof InfraDownError) {
        stages.push({ stage: "author", ok: false, error: "infra_down", detail: e.message, endpoint: e.endpoint, resolvedVia: endpoint.via });
        finish(false, EXIT_BRAMA_DOWN);
      }
      stages.push({ stage: "author", ok: false, error: "author_failed", detail: e.message });
      fail();
    }
  }

  // 3. validate
  const validation = await runValidators({ plan, brief, repo: brief.repo });
  stages.push({ stage: "validate", ok: validation.ok, report: validation });
  if (!validation.ok) fail();


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
