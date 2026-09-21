// What a sync manifest, its state file and one run's outcome look like.
//
// Split out of `sync.ts`, which had grown past the three-hundred-line
// limit; the run itself stays there.

import type { DocumentationFinding } from "../docs/model/types.js";

export const SYNC_MANIFEST_FILE = "kronika.sync.json";
export const SYNC_STATE_FILE = "kronika.sync-state.json";

export type SyncDocument = {
  /** Repository-relative documentation file this entry maintains. */
  output: string;
  /** Repository-relative files or directories that are this document's
   * evidence; also the pathspecs drift detection filters the Git diff by. */
  sources: string[];
  /** Standing documentation goal passed to both the audit and the rewrite. */
  instruction?: string;
  model?: string;
  maxTokens?: number;
  maxInputBytes?: number;
  maxFileBytes?: number;
  maxDiffBytes?: number;
};

export type SyncManifest = {
  schemaVersion: number;
  documents: SyncDocument[];
};

export type SyncStateEntry = {
  headSha: string;
  syncedAt: string;
  lastAction: string;
};

export type SyncState = {
  schemaVersion: number;
  documents: Record<string, SyncStateEntry>;
};

export type SyncOutcome = {
  output: string;
  action: "baseline" | "current" | "advanced" | "checked-current" | "rewritten" | "failed";
  detail: string;
  changedPaths: string[];
  findings: DocumentationFinding[];
};

export type SyncDefaults = {
  model: string;
  maxTokens: number;
  maxInputBytes: number;
  maxFileBytes: number;
  maxDiffBytes: number;
};

export type SyncOptions = {
  repo: string;
  manifestPath: string;
  statePath: string;
  dryRun: boolean;
  defaults: SyncDefaults;
};

export type SyncResult = {
  headSha: string;
  outcomes: SyncOutcome[];
  stateWritten: boolean;
};

