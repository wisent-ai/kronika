import { runCommand } from "../lib.mjs";
import { parseCommandList } from "../stages/detect.mjs";

/** Observe the current command tree, not just the brief's root inventory. */
export async function validateCoverage(plan, brief, repo, binary) {
  if (!Array.isArray(plan?.pages))
    throw new Error("plan.pages must be an array to establish command page coverage");
  if (!Array.isArray(brief?.requiredKinds))
    throw new Error("brief.requiredKinds must be an array from surface detection to establish required page coverage");
  const pages = plan.pages;
  const kinds = new Set(pages.map((page) => page.kind));
  const failures = brief.requiredKinds
    .filter((kind) => !kinds.has(kind))
    .map((kind) => ({ kind, message: `required page kind "${kind}" is missing from the plan` }));
  const cli = brief?.surfaces?.cli;
  if (!cli || typeof cli.declared !== "boolean") {
    failures.push({ message: "brief.surfaces.cli.declared is missing or invalid; detect the product surfaces before validating command coverage" });
    return failures;
  }
  if (!cli.declared) return failures;
  if (cli.ok !== true || !Array.isArray(cli.commands) || !cli.commands.length) {
    const failure = { message: "declared CLI has no successfully observed command inventory; run detection against the actual binary before validating coverage" };
    if (cli.error !== undefined) failure.cause = cli.error;
    failures.push(failure);
    return failures;
  }
  if (!binary) {
    failures.push({ message: "declared CLI binary is unavailable; cannot validate current command coverage" });
    return failures;
  }
  const slugs = pages.filter((page) => page.kind === "cli-reference").map((page) => page.slug);
  const pending = [{ words: [], ancestors: new Set() }];
  while (pending.length) {
    const { words, ancestors } = pending.shift();
    const usage = [binary, ...words, "--help"].join(" ");
    const help = await runCommand(binary, [...words, "--help"], { cwd: repo });
    if (!help.ok) {
      failures.push({ command: words.join(" "), message: `${usage} failed while validating command coverage: ${help.error}` });
      continue;
    }
    const hasCommands = /^Commands:/m.test(help.stdout);
    if (words.length && !hasCommands) {
      if (!/^Usage:/m.test(help.stdout))
        failures.push({ command: words.join(" "), message: `${usage} has neither a readable Commands nor Usage section:\n${help.stdout}` });
      continue;
    }
    if (ancestors.has(help.stdout)) {
      failures.push({ command: words.join(" "), message: `${usage} repeats an ancestor command inventory; nested coverage cannot be established:\n${help.stdout}` });
      continue;
    }
    let commands;
    try {
      commands = parseCommandList(help.stdout);
    } catch (error) {
      failures.push({ command: words.join(" "), message: `${usage}: cannot observe current command coverage: ${error.message}` });
      continue;
    }
    const nextAncestors = new Set(ancestors).add(help.stdout);
    for (const command of commands) {
      if (command === "help") continue;
      const child = [...words, command];
      const slug = `cli/${child.join("/")}`;
      if (!slugs.some((candidate) => candidate === slug || candidate.startsWith(`${slug}/`)))
        failures.push({ command: child.join(" "), message: `command "${child.join(" ")}" is in the binary's --help but no cli-reference page has slug "${slug}"` });
      pending.push({ words: child, ancestors: nextAncestors });
    }
  }
  return failures;
}
