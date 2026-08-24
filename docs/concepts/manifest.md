# Sync manifest

Which documents does the loop maintain, and from what evidence? The sync
manifest — `kronika.sync.json` at the repository root, overridable with
`--manifest` — is the human's committed declaration. Nothing enters the
[sync loop](../sync.md) that is not declared here, and nothing about the
declaration is inferred.

## Shape

```json
{
  "schemaVersion": 1,
  "documents": [
    {
      "output": "docs/usage.md",
      "sources": ["src"],
      "instruction": "Document every CLI flag of src/greet.js."
    }
  ]
}
```

Per entry (`SyncDocument`, `src/sync.ts`):

| Field | Required | Meaning |
|---|---|---|
| `output` | yes | repository-relative documentation file this entry maintains |
| `sources` | yes, non-empty | repository-relative files or directories that are the document's evidence — and the pathspecs [drift](drift.md) detection filters the Git diff by |
| `instruction` | no | standing documentation goal, passed to both the audit and the rewrite |
| `model`, `maxTokens`, `maxInputBytes`, `maxFileBytes`, `maxDiffBytes` | no | per-document overrides of the run's CLI defaults ([cli](../cli.md)) |

This repository's own `kronika.sync.json` declares every page under `docs/`
and is the reference example.

## Lifecycle

- **Entry added** — the document's first tick records a
  [baseline](baseline.md) and generates nothing; maintenance begins at the
  declaration, never with a wholesale rewrite of reviewed prose.
- **Entry edited** — takes effect on the next tick; sources and budgets are
  read fresh every run. Narrowing `sources` narrows both drift detection and
  the audited diff.
- **Entry removed** — the document is simply no longer visited. Its
  [state](state.md) entry remains as an inert record; delete it by hand if
  you want the file minimal.
- The manifest is meant to be committed: it is reviewable, diffable intent.

## Invariants

- Validation is strict and total: the file must exist, parse as JSON, carry
  `schemaVersion: 1`, declare a non-empty `documents` array, and every entry
  must have a non-empty `output` and at least one source.
- The manifest never carries credentials, model endpoints, or machine state
  — endpoints and secrets are environment ([configuration](../configuration.md)),
  progress is [state](state.md).
- One manifest governs one repository; paths are repository-relative and
  confined like every other selection
  ([source-collection](source-collection.md)).

## Refusals

Exact sentences from `loadSyncManifest` (`src/sync.ts`), all fatal before
any document is visited:

- `Sync manifest is missing: <path>. Declare the maintained documents first.`
- `Sync manifest is not valid JSON: <path>`
- `Unsupported sync manifest schemaVersion in <path>`
- `Sync manifest declares no documents: <path>`
- `Sync manifest entry without an output path in <path>`
- `Sync manifest entry <output> declares no sources`

## Not to be confused with

- **The [state file](state.md)** — the loop's memory of what was reconciled;
  the manifest is intent, the state is progress. Manifest edits are human;
  state writes are Kronika's.
- **The [source collection](source-collection.md)** — what one call actually
  read; the manifest's `sources` bound it but budgets and exclusions still
  apply.
- **The site pipeline's `docs-sources.json`** — a different file for a
  different subsystem ([site-pipeline](../site-pipeline.md)).
