#!/usr/bin/env node
// One page of a docs plan as a markdown file a person edits, and back.
//
//   node src/stages/page.mjs export --plan plan.json --slug <slug> --out page.md
//   node src/stages/page.mjs import --plan plan.json --slug <slug> --from page.md
//
// A plan is JSON whose every block carries a claim; editing it by hand means
// editing escaped strings and keeping brackets balanced. Exported, each block
// is one `<!-- block {...} -->` line holding its type, claim and every field
// that is not prose, followed by its prose: a paragraph's text, one `- item`
// per bullet or step, a code block's code between ``` fences, a table's rows
// as `cell | cell` lines, a callout's text. Import parses that back, replaces
// the page in the plan, validates the whole plan and writes it only when it
// is valid. Exits successfully when done, EXIT_STAGE_FAILED when the edited
// page is invalid (nothing is written), EXIT_USAGE on a wrong invocation.
import { readFileSync, writeFileSync } from "node:fs";
import { validatePlan } from "../schema.mjs";
import { printReport, parseCommand, isMain, EXIT_USAGE, EXIT_STAGE_FAILED } from "../lib.mjs";

const USAGE = "node src/stages/page.mjs export|import --plan plan.json --slug <slug> (--out page.md | --from page.md) [--text]";
const FENCE = "```";
const ITEM = "- ";
const SECTION = "## ";

function blockBody(block) {
  switch (block.type) {
    case "paragraph": return [block.text].filter((text) => text !== undefined);
    case "bullets":
    case "steps":
      if (block.items === undefined) return [];
      return block.items.map((item) => `${ITEM}${item}`);
    case "code": return [FENCE, ...block.code.code.split("\n"), FENCE];
    case "table": return block.table.rows.map((row) => row.map((cell) => cell.replaceAll("|", "\\|")).join(" | "));
    case "callout": return [block.callout.text];
    default: throw new Error(`unknown block type ${JSON.stringify(block.type)}`);
  }
}

function blockHeader(block) {
  const header = { type: block.type, claim: block.claim };
  if (block.type === "code") header.code = { ...block.code, code: undefined };
  if (block.type === "table") header.table = { caption: block.table.caption, columns: block.table.columns };
  if (block.type === "callout") header.callout = { ...block.callout, text: undefined };
  return `<!-- block ${JSON.stringify(header)} -->`;
}

export function pageToMarkdown(page) {
  const head = { slug: page.slug, nav: page.nav, group: page.group, kind: page.kind, description: page.description };
  const lines = [`# ${page.title}`, `<!-- page ${JSON.stringify(head)} -->`];
  for (const section of page.sections) {
    lines.push("", `${SECTION}${section.title}`);
    for (const block of section.blocks) lines.push("", blockHeader(block), ...blockBody(block));
  }
  return `${lines.join("\n")}\n`;
}

function finishBlock(header, body) {
  const block = { type: header.type, claim: header.claim };
  const prose = body.join("\n").trim();
  switch (header.type) {
    case "paragraph": block.text = prose; break;
    case "bullets":
    case "steps": block.items = body.filter((line) => line.startsWith(ITEM)).map((line) => line.slice(ITEM.length)); break;
    case "code": {
      const open = body.indexOf(FENCE);
      const close = body.lastIndexOf(FENCE);
      const [, ...code] = body.slice(open, close);
      block.code = { ...header.code, code: code.join("\n") };
      break;
    }
    // Cells are split on an unescaped ` | `; a `|` inside a cell travels as `\|`.
    case "table": block.table = { ...header.table, rows: body.filter((line) => line.trim() !== "").map((line) => line.split(/ (?<!\\)\| /).map((cell) => cell.replaceAll("\\|", "|"))) }; break;
    case "callout": block.callout = { ...header.callout, text: prose }; break;
    default: throw new Error(`unknown block type ${JSON.stringify(header.type)}`);
  }
  return block;
}

export function markdownToPage(markdown) {
  const [titleLine, headLine, ...rest] = markdown.split("\n");
  const title = titleLine.replace(/^# /, "");
  const head = JSON.parse(headLine.replace(/^<!-- page /, "").replace(/ -->$/, ""));
  const page = { slug: head.slug, nav: head.nav, group: head.group, kind: head.kind, title, description: head.description, sections: [] };
  let section = null;
  let header = null;
  let body = [];
  let inFence = false;
  const flush = () => {
    if (header) section.blocks.push(finishBlock(header, body));
    header = null;
    body = [];
  };
  for (const line of rest) {
    if (line === FENCE) inFence = !inFence;
    if (!inFence && line.startsWith(SECTION)) {
      flush();
      section = { title: line.slice(SECTION.length), blocks: [] };
      page.sections.push(section);
    } else if (!inFence && line.startsWith("<!-- block ")) {
      flush();
      header = JSON.parse(line.replace(/^<!-- block /, "").replace(/ -->$/, ""));
    } else if (header) {
      body.push(line);
    }
  }
  flush();
  // Fields the page head left out stay out, as the plan had them.
  for (const key of Object.keys(page)) if (page[key] === undefined) delete page[key];
  return page;
}

function main() {
  const { values, positionals } = parseCommand(USAGE, {
    plan: { type: "string" },
    slug: { type: "string" },
    out: { type: "string" },
    from: { type: "string" },
  }, { positionals: ["mode"], required: "plan slug".split(" ") });
  const plan = JSON.parse(readFileSync(values.plan, "utf8"));
  const page = plan.pages.find((candidate) => candidate.slug === values.slug);
  if (!page) {
    printReport({ error: "usage", detail: `${values.plan} has no page ${values.slug}; it has ${plan.pages.map((candidate) => candidate.slug).join(", ")}` });
    process.exit(EXIT_USAGE);
  }
  if (positionals.mode === "export" && values.out) {
    writeFileSync(values.out, pageToMarkdown(page));
    printReport({ ok: true, exported: values.slug, out: values.out });
    return;
  }
  if (positionals.mode === "import" && values.from) {
    const imported = markdownToPage(readFileSync(values.from, "utf8"));
    plan.pages = plan.pages.map((candidate) => (candidate === page ? imported : candidate));
    const errors = validatePlan(plan);
    if (errors.length) {
      printReport({ ok: false, imported: values.slug, written: false, errors });
      process.exit(EXIT_STAGE_FAILED);
    }
    writeFileSync(values.plan, `${JSON.stringify(plan, null, "  ")}\n`);
    printReport({ ok: true, imported: values.slug, written: values.plan });
    return;
  }
  printReport({ error: "usage", detail: `export needs --out, import needs --from; ${USAGE}` });
  process.exit(EXIT_USAGE);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    printReport({ ok: false, error: error.message });
    process.exit(EXIT_STAGE_FAILED);
  }
}
