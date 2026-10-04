// A secret reaches Kronika only as a role reference (`ROLE#FIELD`): the role
// the vault item plays and the field to read. No item is named, so replacing
// or renaming the item changes nothing here. The value is read through
// `stado credentials get --role ROLE --field FIELD` and never sits in argv,
// the environment or output (cli.md rule 15). `STADO_BIN` names another
// executable; the default is `stado` on PATH. On a machine without Stado,
// `KRONIKA_CREDENTIALS_FILE` names an owner-only JSON file of
// role -> field -> value that answers the reference instead.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** The standard error a failed child process carried, when it carried any. */
const childStderr = (error: unknown): string => {
  if (error && typeof error === "object" && "stderr" in error) {
    return String(error.stderr ?? "").trim();
  }
  return "";
};

/** The value a `ROLE#FIELD` reference names; `source` names where the reference came from. */
export const readCredential = (reference: string, source: string): string => {
  const separator = reference.lastIndexOf("#");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`${source} must be a role reference ROLE#FIELD, not ${JSON.stringify(reference)}`);
  }
  const role = reference.slice(0, separator);
  const field = reference.slice(separator + 1);
  const credentialsFile = process.env.KRONIKA_CREDENTIALS_FILE;
  if (credentialsFile) return localCredential(credentialsFile, role, field, source);
  const binary = process.env.STADO_BIN || "stado";
  let value: string;
  try {
    value = execFileSync(binary, ["credentials", "get", "--role", role, "--field", field], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    const detail = missing
      ? `${binary} cannot be started; without Stado set KRONIKA_CREDENTIALS_FILE to an owner-only JSON file of role -> field -> value`
      : childStderr(error) || (error instanceof Error ? error.message : String(error));
    throw new Error(`${source}: ${binary} credentials get --role ${role} --field ${field} failed: ${detail}`);
  }
  const secret = value.replace(/\n$/, "");
  if (!secret) throw new Error(`${source}: the item playing role ${role} holds no value in field ${field}`);
  return secret;
};

/** `role`'s `field` from the owner-only credentials file; a file other users can read is refused. */
const localCredential = (file: string, role: string, field: string, source: string): string => {
  let mode: number;
  let text: string;
  try {
    mode = statSync(file).mode;
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`${source}: KRONIKA_CREDENTIALS_FILE ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`${source}: KRONIKA_CREDENTIALS_FILE ${file} must be readable by its owner only (mode ${(mode & 0o777).toString(8)})`);
  }
  let roles: unknown;
  try {
    roles = JSON.parse(text);
  } catch {
    throw new Error(`${source}: KRONIKA_CREDENTIALS_FILE ${file} is not a JSON object of role -> field -> value`);
  }
  const fields = roles && typeof roles === "object" ? (roles as Record<string, unknown>)[role] : undefined;
  const value = fields && typeof fields === "object" ? (fields as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "string" || !value) {
    throw new Error(`${source}: KRONIKA_CREDENTIALS_FILE ${file} has no non-empty ${role}#${field}`);
  }
  return value;
};
