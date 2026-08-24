# Walkthrough: one full sync cycle

What does the loop actually print, write, and commit, tick by tick? This
page runs `kronika sync` through every action of its state machine against
a toy repository, with output pasted verbatim. The state machine itself is
[sync](sync.md); the nouns are [manifest](concepts/manifest.md),
[state](concepts/state.md), [baseline](concepts/baseline.md),
[drift](concepts/drift.md).

**How this was captured.** The built CLI (`npm run build`, Node 22) ran
against a scratch repository under `/tmp`. Brama needs real credentials, so
no real model was called: ticks that need no model ran with placeholder
credentials pointing at a closed local port (`BRAMA_URL=http://127.0.0.1:4899`,
`BRAMA_API_KEY=placeholder-not-a-secret`) — the product's own offline path —
and the two model-dependent ticks ran against a local stub on
`127.0.0.1:4891` answering `/v1/chat/completions` with scripted verdicts.
Framing, parsing, validation, atomic writes, and Git behavior are Kronika's
real code paths; only the verdict prose is canned, and it is marked below.

## The toy repository

```text
toy/
  README.md            # not declared as evidence
  src/greet.js         # prints "Hello, <name>!"
  docs/usage.md        # the maintained document
  kronika.sync.json
```

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

## Tick 1 — baseline (no model call)

```console
$ kronika sync --commit
Kronika sync at 39825d883997
  baseline        docs/usage.md — first sync records 39825d883997 as the baseline; nothing is generated on a first run
  committed
```

Exit `0`. Offline credentials sufficed: a first run makes no model call.
`kronika.sync-state.json` now exists and `--commit` landed it as
`kronika sync: advance documentation baselines`:

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

## Tick 2 — the sync commit moves HEAD

```console
$ kronika sync
Kronika sync at 6d6a223d5b73
  advanced        docs/usage.md — no evidence path changed in the range; baseline advanced without a model call
```

Not `current`: the state recorded the HEAD the tick ran at, and tick 1's own
commit then moved HEAD by one. The range contains only the sync commit — no
declared path changed — so the baseline advances for free. `current` appears
when no commit lands between two ticks (tick 8 below).

## Tick 3 — undeclared change (no model call)

Edit `README.md`, which the manifest does not declare, and commit:

```console
$ kronika sync --commit
Kronika sync at 99202b121a20
  advanced        docs/usage.md — no evidence path changed in the range; baseline advanced without a model call
  committed
```

## Tick 4 — drift while Brama is unreachable

`src/greet.js` gains a `--shout` flag (a public-surface change) and is
committed. Now the audit is required, and the offline credentials show the
failure posture:

```console
$ kronika sync
Kronika sync at 9d577cd6dad0
  failed          docs/usage.md — audit did not complete: fetch failed
```

Exit `1`, and the state file still names the tick-3 baseline: a `failed`
outcome never advances, so the next tick retries the same range
([runbook](runbook.md)).

## Tick 5 — dry run of the blocked audit (stub verdict)

With the stub answering the audit — `passed: false`, one blocker
`undocumented-flag` naming the missing `--shout` documentation:

```console
$ kronika sync --dry-run
Kronika sync at 9d577cd6dad0 (dry run)
  rewritten       docs/usage.md — dry run: audit found blockers and a rewrite would be applied. src/greet.js adds a --shout flag that docs/usage.md does not mention.
```

Exit `0`; no file and no state written. `--dry-run --json` carries the full
findings array for review.

## Tick 6 — rewrite, commit (stub verdict and stub rewrite)

```console
$ kronika sync --commit
Kronika sync at 9d577cd6dad0
  rewritten       docs/usage.md — audit found blockers; the document was regenerated with the findings as the correction brief. src/greet.js adds a --shout flag that docs/usage.md does not mention.
  committed
```

The rewrite was instructed with the blocker itself
(`- [undocumented-flag] … Required change: Document the --shout flag …`)
plus the standing manifest instruction — correct exactly the audited
defects, do not re-author unnamed sections. The commit stages exactly the
document and the state:

```console
$ git show --stat --format=%s HEAD
kronika sync: reconcile docs/usage.md

 docs/usage.md           | 5 +++--
 kronika.sync-state.json | 6 +++---
 2 files changed, 6 insertions(+), 5 deletions(-)
```

`docs/usage.md` now documents `--shout` (stub prose), and the state entry
reads `"lastAction": "rewritten"` at the audited HEAD.

## Tick 7 — a change the audit waves through

A comment-only edit to `src/greet.js` is drift (a declared path changed),
so one check runs; the stub verdict passes, and the pass IS the update:

```console
$ kronika sync
Kronika sync at 1d5ccd2b41d0
  checked-current docs/usage.md — audit passed: docs/usage.md already documents the changed greeting behavior; no public surface is missing.
```

No file changed; the baseline moved.

## Tick 8 — current

Run again with nothing committed in between:

```console
$ kronika sync
Kronika sync at 1d5ccd2b41d0
  current         docs/usage.md — already reconciled against HEAD
```

## What the cycle demonstrates

| Tick | Action | Model calls | Exit |
|---|---|---|---|
| 1 | `baseline` | 0 | 0 |
| 2, 3 | `advanced` | 0 | 0 |
| 4 | `failed` (offline) | attempted 1 | 1 |
| 5 | `rewritten` (dry run) | 1 check | 0 |
| 6 | `rewritten` + commit | check + write | 0 |
| 7 | `checked-current` | 1 check | 0 |
| 8 | `current` | 0 | 0 |

Unattended operation is the same loop with `--commit --push` on a schedule
([examples/sync-forever.sh](examples/sync-forever.sh)); the one-shot gate is
[walkthrough-check](walkthrough-check.md).
