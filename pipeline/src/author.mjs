#!/usr/bin/env node
// Plan authoring: the model writes a typed content plan — never markup.
// Endpoint resolution: BRAMA_URL env, else the local Stado resolver's brama
// adapter. No provider fallback: no Brama, no authoring — exit 69 with the
// named infrastructure error instead of calling a provider directly.
import { parseArgs } from "node:util";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { validatePlan } from "./schema.mjs";
import {
  expandPath, readJson, printReport, die, runCommand, isMain,
  resolveEndpoint, chatComplete, InfraDownError,
} from "./lib.mjs";

const SCHEMA_PATH = new URL("../schemas/plan.schema.json", import.meta.url);

const WRITING_CONTRACT = `You author a documentation content plan as a single JSON document.
Rules (each is mechanically validated; violations fail the build):
- Emit ONLY JSON conforming exactly to the schema below. No markdown, no fences, no prose outside the JSON.
- Page kinds are closed. Never invent a page type or a structural convention that is not in the schema.
- Every content block MUST carry a claim: a source name from plan.sources plus an evidence string that occurs VERBATIM in that source (or a regex with evidenceIsRegex true). Never attach evidence post-hoc; copy it from the source excerpts you were given.
- Command sources may only be the product binary with --help/--version arguments.
- Every documented command line and --flag must exist in the live binary's --help.
- Declare every recurring concept term in plan.terms with the page slug that defines it.
- Cover every required page kind from the brief.`;

function excerpt(absPath, limit = 6000) {
  const text = readFileSync(absPath, "utf8");
  return text.length > limit ? `${text.slice(0, limit)}\n[... truncated]` : text;
}

async function collectExcerpts(declared, brief, repo) {
  const excerpts = {};
  if (brief.surfaces?.cli?.ok) {
    const help = await runCommand(brief.surfaces.cli.binary, ["--help"], { timeoutMs: 10000 });
    excerpts[`${brief.product} --help`] = help.stdout;
  }
  const files = { ...(declared.docs ?? {}) };
  for (const key of ["changelog", "config", "routes", "limits"]) {
    if (declared[key]) files[key] = declared[key];
  }
  for (const [name, rel] of Object.entries(files)) {
    const abs = expandPath(rel, repo);
    if (existsSync(abs)) excerpts[rel] = excerpt(abs);
  }
  return excerpts;
}

function extractJson(content) {
  let text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("no JSON object in model answer");
  text = text.slice(first, last + 1);
  try {
    return JSON.parse(text);
  } catch {
    // one repair pass: trailing commas
    return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
  }
}

/** Throws InfraDownError when Brama is unreachable. */
export async function authorPlan({ brief, sources, repo, model = "default", endpoint = resolveEndpoint() }) {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const excerpts = await collectExcerpts(sources, brief, repo);
  const messages = [
    { role: "system", content: `${WRITING_CONTRACT}\n\nThe plan JSON Schema:\n${schema}` },
    {
      role: "user",
      content:
        `Product brief (computed from the repository):\n${JSON.stringify(brief, null, 2)}\n\n` +
        `Source excerpts (the only material evidence may be copied from):\n${JSON.stringify(excerpts, null, 2)}\n\n` +
        `Write the complete plan JSON now.`,
    },
  ];
  const content = await chatComplete({ endpoint: endpoint.url, messages, model });
  const plan = extractJson(content);
  const schemaErrors = validatePlan(plan);
  return { plan, schemaErrors, endpoint };
}

async function main() {
  const { values } = parseArgs({
    options: {
      brief: { type: "string" },
      sources: { type: "string" },
      out: { type: "string", default: "plan.json" },
      repo: { type: "string" },
      model: { type: "string", default: "default" },
    },
  });
  if (!values.brief || !values.sources) {
    printReport({ error: "usage", detail: "node src/author.mjs --brief brief.json --sources docs-sources.json [--repo path] [--out plan.json] [--model m]" });
    process.exit(2);
  }
  const brief = readJson(values.brief);
  const sources = readJson(values.sources);
  const repo = expandPath(values.repo ?? brief.repo ?? process.cwd());
  const endpoint = resolveEndpoint();
  try {
    const { plan, schemaErrors } = await authorPlan({ brief, sources, repo, model: values.model, endpoint });
    if (schemaErrors.length > 0) {
      die({ error: "invalid_plan", detail: "model plan failed schema validation", schemaErrors }, 1);
    }
    writeFileSync(values.out, JSON.stringify(plan, null, 2) + "\n");
    printReport({ ok: true, out: values.out, pages: plan.pages.length, endpoint: endpoint.url, resolvedVia: endpoint.via });
  } catch (e) {
    if (e instanceof InfraDownError) {
      die({ error: "infra_down", detail: e.message, endpoint: e.endpoint, resolvedVia: endpoint.via }, 69);
    }
    die({ error: "author_failed", detail: e.message }, 1);
  }
}

if (isMain(import.meta.url)) await main();
