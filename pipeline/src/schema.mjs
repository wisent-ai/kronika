#!/usr/bin/env node
// Hand-rolled validator implementing schemas/plan.schema.json exactly:
// closed page kinds, a claim required on every block, additionalProperties
// false everywhere. Returns [] or a list of { path, message } errors.
import { parseArgs } from "node:util";
import { readJson, printReport, isMain } from "./lib.mjs";

export const PAGE_KINDS = [
  "overview", "quick-start", "task-guide", "examples", "concept",
  "cli-reference", "api-reference", "config-reference", "sdk-reference",
  "changelog", "migration", "versions", "troubleshooting", "security",
  "limits", "support", "faq", "definitions", "contributing",
];
export const BLOCK_TYPES = ["paragraph", "bullets", "steps", "code", "table", "callout"];
const SOURCE_KINDS = ["file", "command", "url"];
const CALLOUT_TONES = ["note", "tip"];
const SLUG_RE = /^[a-z0-9-]+$/;

export function validatePlan(plan) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = (v, path, minLength = 0) => {
    if (typeof v !== "string") { err(path, "must be a string"); return false; }
    if (v.length < minLength) { err(path, `must have minLength ${minLength}`); return false; }
    return true;
  };
  const closed = (obj, path, allowed) => {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) err(`${path}.${k}`, `additional property not allowed (allowed: ${allowed.join(", ")})`);
    }
  };
  const required = (obj, path, keys) => {
    let ok = true;
    for (const k of keys) {
      if (!(k in obj)) { err(`${path}.${k}`, "required property missing"); ok = false; }
    }
    return ok;
  };
  const oneOf = (v, path, values) => {
    if (!values.includes(v)) { err(path, `must be one of: ${values.join(", ")}`); return false; }
    return true;
  };
  const strArray = (v, path) => {
    if (!Array.isArray(v)) { err(path, "must be an array"); return; }
    v.forEach((item, i) => str(item, `${path}[${i}]`));
  };

  if (!isObj(plan)) { err("$", "plan must be an object"); return errors; }
  closed(plan, "$", ["product", "version", "sources", "terms", "pages"]);
  if (!required(plan, "$", ["product", "version", "sources", "terms", "pages"])) return errors;

  str(plan.product, "$.product", 1);
  str(plan.version, "$.version", 1);

  // sources: named registry
  if (!isObj(plan.sources)) {
    err("$.sources", "must be an object");
  } else {
    for (const [name, src] of Object.entries(plan.sources)) {
      const p = `$.sources.${name}`;
      if (!isObj(src)) { err(p, "must be an object"); continue; }
      closed(src, p, ["kind", "location"]);
      if (!required(src, p, ["kind", "location"])) continue;
      oneOf(src.kind, `${p}.kind`, SOURCE_KINDS);
      str(src.location, `${p}.location`);
    }
  }

  // terms
  if (!Array.isArray(plan.terms)) {
    err("$.terms", "must be an array");
  } else {
    plan.terms.forEach((t, i) => {
      const p = `$.terms[${i}]`;
      if (!isObj(t)) { err(p, "must be an object"); return; }
      closed(t, p, ["term", "definedOn"]);
      if (!required(t, p, ["term", "definedOn"])) return;
      str(t.term, `${p}.term`);
      str(t.definedOn, `${p}.definedOn`);
    });
  }

  // pages
  if (!Array.isArray(plan.pages)) {
    err("$.pages", "must be an array");
    return errors;
  }
  if (plan.pages.length < 1) err("$.pages", "must have minItems 1");
  plan.pages.forEach((page, pi) => {
    const pp = `$.pages[${pi}]`;
    if (!isObj(page)) { err(pp, "must be an object"); return; }
    closed(page, pp, ["slug", "nav", "group", "kind", "title", "description", "sections"]);
    if (!required(page, pp, ["slug", "nav", "kind", "title", "description", "sections"])) return;
    if (str(page.slug, `${pp}.slug`) && !SLUG_RE.test(page.slug)) {
      err(`${pp}.slug`, "must match ^[a-z0-9-]+$");
    }
    str(page.nav, `${pp}.nav`);
    if ("group" in page) str(page.group, `${pp}.group`);
    oneOf(page.kind, `${pp}.kind`, PAGE_KINDS);
    str(page.title, `${pp}.title`);
    str(page.description, `${pp}.description`);
    if (!Array.isArray(page.sections)) { err(`${pp}.sections`, "must be an array"); return; }
    if (page.sections.length < 1) err(`${pp}.sections`, "must have minItems 1");
    page.sections.forEach((section, si) => {
      const sp = `${pp}.sections[${si}]`;
      if (!isObj(section)) { err(sp, "must be an object"); return; }
      closed(section, sp, ["title", "blocks"]);
      if (!required(section, sp, ["title", "blocks"])) return;
      str(section.title, `${sp}.title`);
      if (!Array.isArray(section.blocks)) { err(`${sp}.blocks`, "must be an array"); return; }
      if (section.blocks.length < 1) err(`${sp}.blocks`, "must have minItems 1");
      section.blocks.forEach((block, bi) => {
        const bp = `${sp}.blocks[${bi}]`;
        if (!isObj(block)) { err(bp, "must be an object"); return; }
        closed(block, bp, ["type", "claim", "text", "items", "code", "table", "callout"]);
        if (!required(block, bp, ["type", "claim"])) return;
        oneOf(block.type, `${bp}.type`, BLOCK_TYPES);

        // claim — required on every block; a block without one cannot exist
        const cp = `${bp}.claim`;
        if (!isObj(block.claim)) {
          err(cp, "must be an object");
        } else {
          closed(block.claim, cp, ["source", "evidence", "evidenceIsRegex"]);
          if (required(block.claim, cp, ["source", "evidence"])) {
            str(block.claim.source, `${cp}.source`);
            str(block.claim.evidence, `${cp}.evidence`, 3);
            if ("evidenceIsRegex" in block.claim && typeof block.claim.evidenceIsRegex !== "boolean") {
              err(`${cp}.evidenceIsRegex`, "must be a boolean");
            }
          }
        }

        if ("text" in block) str(block.text, `${bp}.text`);
        if ("items" in block) strArray(block.items, `${bp}.items`);
        if ("code" in block) {
          const kp = `${bp}.code`;
          if (!isObj(block.code)) {
            err(kp, "must be an object");
          } else {
            closed(block.code, kp, ["label", "code"]);
            if (required(block.code, kp, ["code"])) {
              str(block.code.code, `${kp}.code`);
              if ("label" in block.code) str(block.code.label, `${kp}.label`);
            }
          }
        }
        if ("table" in block) {
          const tp = `${bp}.table`;
          if (!isObj(block.table)) {
            err(tp, "must be an object");
          } else {
            closed(block.table, tp, ["caption", "columns", "rows"]);
            if (required(block.table, tp, ["columns", "rows"])) {
              strArray(block.table.columns, `${tp}.columns`);
              if (!Array.isArray(block.table.rows)) err(`${tp}.rows`, "must be an array");
              else block.table.rows.forEach((row, ri) => strArray(row, `${tp}.rows[${ri}]`));
              if ("caption" in block.table) str(block.table.caption, `${tp}.caption`);
            }
          }
        }
        if ("callout" in block) {
          const ap = `${bp}.callout`;
          if (!isObj(block.callout)) {
            err(ap, "must be an object");
          } else {
            closed(block.callout, ap, ["title", "text", "tone"]);
            if (required(block.callout, ap, ["text"])) {
              str(block.callout.text, `${ap}.text`);
              if ("title" in block.callout) str(block.callout.title, `${ap}.title`);
              if ("tone" in block.callout) oneOf(block.callout.tone, `${ap}.tone`, CALLOUT_TONES);
            }
          }
        }
      });
    });
  });

  return errors;
}

function main() {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  if (positionals.length !== 1) {
    printReport({ error: "usage", detail: "node src/schema.mjs <plan.json>" });
    process.exit(2);
  }
  const errors = validatePlan(readJson(positionals[0]));
  printReport({ ok: errors.length === 0, errors });
  process.exit(errors.length === 0 ? 0 : 1);
}

if (isMain(import.meta.url)) main();
