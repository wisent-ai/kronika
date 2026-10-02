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
// is valid. Exit 0 done, 1 the edited page is invalid (nothing is written),
// 2 a wrong invocation.
import { readFileSync, writeFileSync } from "node:fs";
import { validatePlan } from "../schema.mjs";
import { printReport, parseCommand, isMain } from "../lib.mjs";

const USAGE = "node src/stages/page.mjs export|import --plan plan.json --slug <slug> (--out page.md | --from page.md) [--text]";
const FENCE = "```";

function blockBody(block) {
  switch (block.type) {
    case "paragraph": return [block.text ?? ""];
    case "bullets":
    case "steps": return (block.items ?? []).map((item) => `- ${item}`);
    case "code": return [FENCE, ...block.code.code.split("\n"), FENCE];
    case "table": return block.table.rows.map((row) => row.map((cell) => cell.replaceAll("|", "\\|")).join(" | "));
    case "callout": return [block.callout.text];
    default: return [];
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
    lines.push("", `## ${section.title}`);
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
    case "steps": block.items = body.filter((line) => line.startsWith("- ")).map((line) => line.slice(2)); break;
    case "code": {
      const open = body.indexOf(FENCE);
      const close = body.lastIndexOf(FENCE);
      block.code = { ...header.code, code: body.slice(open + 1, close).join("\n") };
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
  const lines = markdown.split("\n");
  const title = lines[0].replace(/^# /, "");
  const head = JSON.parse(lines[1].replace(/^<!-- page /, "").replace(/ -->$/, ""));
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
  for (const line of lines.slice(2)) {
    if (line === FENCE) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) {
      flush();
      section = { title: line.slice(3), blocks: [] };
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
  }, { positionals: 1, required: "plan slug".split(" ") });
  const plan = JSON.parse(readFileSync(values.plan, "utf8"));
  const index = plan.pages.findIndex((page) => page.slug === values.slug);
  if (index < 0) {
    printReport({ error: "usage", detail: `${values.plan} has no page ${values.slug}; it has ${plan.pages.map((page) => page.slug).join(", ")}` });
    process.exit(2);
  }
  if (positionals[0] === "export" && values.out) {
    writeFileSync(values.out, pageToMarkdown(plan.pages[index]));
    printReport({ ok: true, exported: values.slug, out: values.out });
    return;
  }
  if (positionals[0] === "import" && values.from) {
    plan.pages[index] = markdownToPage(readFileSync(values.from, "utf8"));
    const errors = validatePlan(plan);
    if (errors.length) {
      printReport({ ok: false, imported: values.slug, written: false, errors });
      process.exit(1);
    }
    writeFileSync(values.plan, `${JSON.stringify(plan, null, 2)}\n`);
    printReport({ ok: true, imported: values.slug, written: values.plan });
    return;
  }
  printReport({ error: "usage", detail: `export needs --out, import needs --from; ${USAGE}` });
  process.exit(2);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    printReport({ ok: false, error: error.message });
    process.exit(1);
  }
}
