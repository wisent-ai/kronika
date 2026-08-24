# Sync state

How does a loop that runs forever avoid redoing work — or worse, silently
skipping it? The sync state file — `kronika.sync-state.json`, overridable
with `--state` — is the loop's committed memory: per maintained document,
the last commit it was reconciled against and what reconciled it.

## Shape

Captured from a real first tick:

```json
{
  "schemaVersion": 1,
  "documents": {
    "docs/usage.md": {
      "headSha": "39825d883997f79f823e7d9be4a24d3f0ea77321",
      "syncedAt": "2026-08-24T22:03:29.990Z",
      "lastAction": "baseline"
    }
  }
}
```

Per entry (`SyncStateEntry`, `src/sync.ts`):

| Field | Meaning |
|---|---|
| `headSha` | the [baseline](baseline.md): full commit SHA the document was last reconciled against |
| `syncedAt` | ISO-8601 timestamp of that reconciliation |
| `lastAction` | what advanced it: `baseline`, `advanced`, `checked-current`, or `rewritten` |

`current` and `failed` never appear in `lastAction`: a `current` tick writes
nothing, and a `failed` outcome deliberately does not advance.

## Lifecycle

- **Missing file** — valid: no document has a baseline yet; every entry's
  first tick records one.
- **Written** — only when at least one entry advanced and the run is not
  `--dry-run`; the file is rewritten whole, pretty-printed, trailing
  newline.
- **Committed** — `--commit` stages it beside any rewritten documents; the
  state is the auditable record of the loop and belongs in history.
- **Entry deleted by hand** — that document re-baselines on the next tick.
  This is the one supported recovery for a baseline that can no longer be
  diffed (rewritten history) and for a corrupt entry.
- **Whole file deleted** — every document re-baselines; nothing is
  generated, so the cost is only that drift since the old baselines is no
  longer visible.

## Invariants

- The state never contains prose, findings, or model output — only the
  coordinates of agreement. Everything else is reconstructible from Git.
- A `failed` outcome never advances `headSha`, so the next tick retries the
  same range; the loop cannot lose a defect by crashing past it
  ([baseline](baseline.md)).
- Validation is strict: invalid JSON and unknown `schemaVersion` are fatal;
  a missing or null `documents` map is normalized to empty.
- State writes are plain `writeFileSync` — last writer wins. Run one sync
  per repository at a time; two concurrent syncs of the same repo can race
  on the state file and on `--commit`.

## Refusals

Exact sentences from `loadSyncState` (`src/sync.ts`):

- `Sync state is not valid JSON: <path>. Fix or delete it to re-baseline.`
- `Unsupported sync state schemaVersion in <path>`

And the per-document `failed` detail when a recorded baseline is gone,
captured verbatim (dry run, fabricated SHA):

```text
failed          docs/usage.md — the recorded baseline 111111111111 cannot be
diffed against HEAD: <git's own error>. Delete this entry from the state
file to re-baseline.
```

## Not to be confused with

- **The [manifest](manifest.md)** — human intent, edited by people; the
  state is machine progress, written by Kronika.
- **The [baseline](baseline.md)** — one entry's `headSha`; the state file is
  the container for all of them.
- **Git itself** — the state names commits but holds no content; deleting it
  loses no document.
