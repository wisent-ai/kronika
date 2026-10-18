#!/usr/bin/env node
// Plan authoring: the model writes a typed content plan — never markup — as
// one JSON object bound to the plan schema.
// Endpoint resolution: BRAMA_URL env, else the address Stado's service
// directory published for this machine (~/.stado/forwards/brama.local). No
// provider fallback: no Brama, no authoring — a named error instead of
// calling a provider directly.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validatePlan } from "../schema.mjs";
import { strictAnswerSchema, planFromAnswer } from "../answer.mjs";
import {
  expandPath, readJson, printReport, parseCommand, die, runCommand, isMain,
  resolveEndpoint, chatObject, InfraDownError, EndpointNotConfiguredError,
  EXIT_STAGE_FAILED, EXIT_BRAMA_DOWN,
} from "../lib.mjs";

const SCHEMA_PATH = new URL("../schemas/plan.schema.json", import.meta.url);
const STANDARD_PATH = new URL("../WRITING-STANDARD.md", import.meta.url);

const WRITING_CONTRACT = `You author a documentation content plan, answered as the one JSON object its schema describes.
- Page kinds are closed. Never invent a page type or a structural convention that is not in the schema.
- Every content block MUST carry a claim: a source name from plan.sources plus an evidence string that occurs VERBATIM in that source (or a regex with evidenceIsRegex true). Never attach evidence post-hoc; copy it from the source excerpts you were given.
- Command sources may only be the product binary with --help/--version arguments.
- Every documented command line and --flag must exist in the live binary's --help.
- Declare every recurring concept term in plan.terms with the page slug that defines it.
- Cover every required page kind from the brief.
- A property you do not use is null; plan.sources is a list of { key, value } entries, the key being the source name.`;

// The material evidence may be copied from: the live binary's --help, and
// every file the brief found readable, keyed by its path in the repository.
async function collectExcerpts(brief, repo) {
  const excerpts = {};
  if (brief.surfaces.cli.ok) {
    const help = await runCommand(brief.surfaces.cli.binary, ["--help"], { cwd: repo });
    if (!help.ok) {
      throw new Error(
        `cannot collect authoring evidence from ${brief.surfaces.cli.binary} --help: ` +
        `exit ${help.code}; ${help.error}\nstdout:\n${help.stdout}\nstderr:\n${help.stderr}`,
      );
    }
    excerpts[`${brief.product} --help`] = help.stdout;
  }
  const files = [...Object.values(brief.surfaces), ...Object.values(brief.docs)].filter((found) => found.path && found.ok);
  for (const file of files) excerpts[path.relative(repo, file.path)] = readFileSync(file.path, "utf8");
  return excerpts;
}

/** Throws InfraDownError when Brama is unreachable. */
export async function authorPlan({ brief, repo, model, endpoint }) {
  const planSchema = readJson(SCHEMA_PATH);
  const standard = readFileSync(STANDARD_PATH, "utf8");
  const excerpts = await collectExcerpts(brief, repo);
  const messages = [
    { role: "system", content: `${WRITING_CONTRACT}\n\nThe writing standard (how pages must read and behave; follow it exactly):\n${standard}` },
    {
      role: "user",
      content:
        `Product brief (computed from the repository):\n${JSON.stringify(brief, null, "  ")}\n\n` +
        `Source excerpts (the only material evidence may be copied from):\n${JSON.stringify(excerpts, null, "  ")}\n\n` +
        `Write the complete plan now.`,
    },
  ];
  const answer = { name: "documentation_plan", schema: strictAnswerSchema(planSchema) };
  const object = await chatObject({ endpoint: endpoint.url, messages, model, answer });
  const plan = planFromAnswer(object, planSchema);
  const schemaErrors = validatePlan(plan);
  return { plan, schemaErrors, endpoint };
}

async function main() {
  const { values } = parseCommand(
    "node src/stages/author.mjs --brief brief.json [--repo path] [--out plan.json] [--model m] [--text]",
    {
      brief: { type: "string" },
      out: { type: "string", default: "plan.json" },
      repo: { type: "string" },
      model: { type: "string", default: "default" },
    },
    { positionals: [], required: ["brief"] },
  );
  const brief = readJson(values.brief);
  const repo = expandPath(values.repo ?? brief.repo);
  let endpoint;
  try {
    endpoint = resolveEndpoint();
  } catch (e) {
    if (!(e instanceof EndpointNotConfiguredError)) throw e;
    die({ error: "not_configured", detail: e.message }, EXIT_STAGE_FAILED);
  }
  try {
    const { plan, schemaErrors } = await authorPlan({ brief, repo, model: values.model, endpoint });
    if (schemaErrors.length) {
      die({ error: "invalid_plan", detail: "model plan failed schema validation", schemaErrors }, EXIT_STAGE_FAILED);
    }
    writeFileSync(values.out, JSON.stringify(plan, null, "  ") + "\n");
    printReport({ ok: true, out: values.out, pages: plan.pages.length, endpoint: endpoint.url, resolvedVia: endpoint.via });
  } catch (e) {
    if (e instanceof InfraDownError) {
      die({ error: "infra_down", detail: e.message, endpoint: e.endpoint, resolvedVia: endpoint.via }, EXIT_BRAMA_DOWN);
    }
    die({ error: "author_failed", detail: e.message }, EXIT_STAGE_FAILED);
  }
}

if (isMain(import.meta.url)) await main();
