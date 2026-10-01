// A secret reaches Kronika only as a Skarbiec reference (`ITEM#FIELD`): the
// value is read from the `skarbiec` executable and never sits in argv, the
// environment or output (cli.md rule 15). `SKARBIEC_BIN` names another
// executable; the default is `skarbiec` on PATH.

import { execFileSync } from "node:child_process";

/** The standard error a failed child process carried, when it carried any. */
const childStderr = (error: unknown): string => {
  if (error && typeof error === "object" && "stderr" in error) {
    return String(error.stderr ?? "").trim();
  }
  return "";
};

/** The value a Skarbiec `ITEM#FIELD` reference names; `source` names where the reference came from. */
export const readCredential = (reference: string, source: string): string => {
  const separator = reference.lastIndexOf("#");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`${source} must be a Skarbiec reference ITEM#FIELD, not ${JSON.stringify(reference)}`);
  }
  const item = reference.slice(0, separator);
  const field = reference.slice(separator + 1);
  const binary = process.env.SKARBIEC_BIN || "skarbiec";
  let value: string;
  try {
    value = execFileSync(binary, ["get", item, "--field", field], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = childStderr(error) || (error instanceof Error ? error.message : String(error));
    throw new Error(`${source}: skarbiec get ${item} --field ${field} failed: ${detail}`);
  }
  const secret = value.replace(/\n$/, "");
  if (!secret) throw new Error(`${source}: Skarbiec item ${item} field ${field} is empty`);
  return secret;
};
