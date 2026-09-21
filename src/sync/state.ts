// Reading the two documents a sync run consults in the target repository:
// the manifest a person wrote and the state the last run left, plus the
// git questions asked about them.
//
// Split out of `sync.ts`, which had grown past the three-hundred-line
// limit.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import type { DocumentationFinding } from "../docs/model/types.js";

import { SYNC_STATE_FILE } from "./shape.js";
import type { SyncDocument, SyncManifest, SyncState } from "./shape.js";

export const git = (repo: string, args: string[]): string => execFileSync(
  "git",
  ["-C", repo, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
).trim();

export const loadSyncManifest = (path: string): SyncManifest => {
  if (!existsSync(path)) {
    throw new Error(`Sync manifest is missing: ${path}. Declare the maintained documents first.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Sync manifest is not valid JSON: ${path}`);
  }
  const manifest = parsed as SyncManifest;
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported sync manifest schemaVersion in ${path}`);
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error(`Sync manifest declares no documents: ${path}`);
  }
  for (const document of manifest.documents) {
    if (typeof document.output !== "string" || document.output.length === 0) {
      throw new Error(`Sync manifest entry without an output path in ${path}`);
    }
    if (!Array.isArray(document.sources) || document.sources.length === 0) {
      throw new Error(`Sync manifest entry ${document.output} declares no sources`);
    }
  }
  return manifest;
};

export const loadSyncState = (path: string): SyncState => {
  if (!existsSync(path)) {
    return { schemaVersion: 1, documents: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Sync state is not valid JSON: ${path}. Fix or delete it to re-baseline.`);
  }
  const state = parsed as SyncState;
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported sync state schemaVersion in ${path}`);
  }
  if (state.documents === undefined || state.documents === null) {
    state.documents = {};
  }
  return state;
};

/** Changed paths between two commits, restricted to this document's evidence
 * and to the document itself — a hand edit to the document must advance its
 * baseline exactly like a source change that the audit passes. */
export const changedPathsFor = (
  repo: string,
  baseSha: string,
  headSha: string,
  document: SyncDocument,
): string[] => {
  const names = git(repo, [
    "diff",
    "--name-only",
    "--find-renames",
    `${baseSha}...${headSha}`,
    "--",
    ...document.sources,
    document.output,
  ]);
  return names.length === 0 ? [] : names.split("\n");
};

export const rewriteInstruction = (document: SyncDocument, findings: DocumentationFinding[]): string => {
  const defects = findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => {
      const change = finding.requiredChange === null ? "" : ` Required change: ${finding.requiredChange}`;
      return `- [${finding.code}] ${finding.message}${change}`;
    })
    .join("\n");
  const standing = document.instruction === undefined ? "" : `${document.instruction}\n\n`;
  return `${standing}Preserve the document's existing structure, voice, and correct content. Correct exactly the audited defects below; do not re-author sections the audit did not name.\n${defects}`;
};
