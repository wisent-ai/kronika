// One answer, two forms from the same data: with `--json` the document
// machines read, otherwise one `path: value` line per leaf field for a
// person — nested keys joined with dots, list items indexed, an empty list
// as `[]`, a null as `-`.

export const renderLines = (value: unknown, path = "", lines: string[] = []): string[] => {
  if (Array.isArray(value)) {
    if (value.length === 0) lines.push(`${path}: []`);
    value.forEach((item, index) => renderLines(item, `${path}[${index}]`, lines));
    return lines;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      renderLines(field, path ? `${path}.${key}` : key, lines);
    }
    return lines;
  }
  lines.push(`${path}: ${value === null || value === undefined ? "-" : String(value)}`);
  return lines;
};

export const printAnswer = (value: unknown, json: boolean): void => {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderLines(value).map((line) => `${line}\n`).join(""));
};
