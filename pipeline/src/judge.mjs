#!/usr/bin/env node
// Rubric judgment: a second model scores the plan against rubric/rubric.json
// (five binary lines; a stub until a docs rubric exists in Probierz).
// Same endpoint resolution and infra semantics as author.mjs. --skip records
// "judge skipped: <reason>" instead of failing the pipeline.
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  expandPath, readJson, printReport, die, isMain,
  resolveEndpoint, chatComplete, InfraDownError,
} from "./lib.mjs";

const RUBRIC_PATH = new URL("../rubric/rubric.json", import.meta.url);

export function loadRubric(rubricPath) {
  const rubric = JSON.parse(readFileSync(rubricPath ?? RUBRIC_PATH, "utf8"));
  if (!Array.isArray(rubric.lines) || rubric.lines.length === 0) throw new Error("rubric has no lines");
  return rubric;
}

export function skippedReport(reason) {
  return { ok: true, judge: "skipped", note: `judge skipped: ${reason}` };
}

/** Throws InfraDownError when Brama is unreachable. */
export async function judgePlan({ plan, rubric, model = "default", endpoint = resolveEndpoint() }) {
  const messages = [
    {
      role: "system",
      content:
        "You are a strict documentation judge. Score the content plan against each rubric line. " +
        "Every line is binary. Answer ONLY JSON of the shape " +
        '{"results":[{"id":"<line id>","pass":true|false,"why":"<one sentence>"}]} ' +
        "with exactly one result per rubric line, in order.",
    },
    {
      role: "user",
      content:
        `Rubric lines:\n${JSON.stringify(rubric.lines, null, 2)}\n\n` +
        `The plan to judge:\n${JSON.stringify(plan, null, 2)}`,
    },
  ];
  const content = await chatComplete({ endpoint: endpoint.url, messages, model });
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("no JSON object in judge answer");
  const verdict = JSON.parse(content.slice(first, last + 1));
  if (!Array.isArray(verdict.results)) throw new Error("judge answer has no results array");
  const results = rubric.lines.map((line) => {
    const r = verdict.results.find((x) => x.id === line.id);
    return { id: line.id, pass: r?.pass === true, why: r?.why ?? "no verdict for this line" };
  });
  const passed = results.filter((r) => r.pass).length;
  return { ok: passed === results.length, judge: "scored", score: `${passed}/${results.length}`, results };
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      rubric: { type: "string" },
      skip: { type: "boolean", default: false },
      reason: { type: "string", default: "requested by --skip" },
      model: { type: "string", default: "default" },
    },
  });
  if (!values.plan) {
    printReport({ error: "usage", detail: "node src/judge.mjs --plan plan.json [--skip [--reason r]] [--rubric path] [--model m]" });
    process.exit(2);
  }
  if (values.skip) {
    printReport(skippedReport(values.reason));
    process.exit(0);
  }
  const plan = readJson(values.plan);
  const rubric = loadRubric(values.rubric && expandPath(values.rubric));
  const endpoint = resolveEndpoint();
  try {
    const report = await judgePlan({ plan, rubric, model: values.model, endpoint });
    printReport({ ...report, endpoint: endpoint.url, resolvedVia: endpoint.via });
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    if (e instanceof InfraDownError) {
      die({ error: "infra_down", detail: e.message, endpoint: e.endpoint, resolvedVia: endpoint.via }, 69);
    }
    die({ error: "judge_failed", detail: e.message }, 1);
  }
}

if (isMain(import.meta.url)) await main();
