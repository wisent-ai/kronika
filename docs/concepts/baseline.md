# Baseline

From which commit does "has anything changed?" get measured? The baseline:
the commit SHA recorded per document in the [state file](state.md), naming
the last point where that document and its declared evidence were known to
agree. Every sync decision is a comparison between a baseline and `HEAD`.

## What it is

One `headSha` per manifest document. A tick resolves the repository's
`HEAD` once (`git rev-parse --verify HEAD^{commit}`), then classifies each
document by its baseline:

| Baseline vs HEAD | Action | Model calls | Baseline moves |
|---|---|---|---|
| no baseline | `baseline` — record HEAD, generate nothing | none | to HEAD |
| equal to HEAD | `current` | none | no (already there) |
| behind, no [drift](drift.md) | `advanced` | none | to HEAD |
| behind, drift, [audit](audit.md) passes | `checked-current` | one check | to HEAD |
| behind, drift, audit blocks | `rewritten` — regenerate with the findings as the brief | check + write | to HEAD |
| undiffable, or audit/rewrite error | `failed` | varies | **no** |

## Baseline before generation

A document's first tick records where maintenance begins and touches
nothing else. Captured verbatim:

```text
Kronika sync at 39825d883997
  baseline        docs/usage.md — first sync records 39825d883997 as the baseline; nothing is generated on a first run
```

The reasoning is in `src/sync.ts` itself: a first run that rewrote every
document through a model would replace reviewed prose wholesale; sync
maintains documents from the moment they enter the manifest.

## Advancing without churn

A passing audit *is* the update — the baseline moves and no file changes.
So does a hand edit to the document itself: the document is included in its
own drift pathspecs precisely so that human maintenance advances the
baseline like a passing audit. And a range in which no declared path changed
advances with no model call at all:

```text
  advanced        docs/usage.md — no evidence path changed in the range; baseline advanced without a model call
```

One observed consequence of `--commit`: the state records the `HEAD` the
tick ran at, and the sync commit itself then moves `HEAD` by one. The next
tick therefore reports `advanced` (a free baseline move over the sync
commit), not `current`. `current` appears when nothing was committed
between two ticks.

## Failure keeps the range

`failed` never advances the baseline, so the next tick retries the same
`baseline...HEAD` range — an outage cannot skip a defect past the loop.
Captured with Brama unreachable:

```text
Kronika sync at 9d577cd6dad0
  failed          docs/usage.md — audit did not complete: fetch failed
```

(exit status `1`; the state file still names the previous baseline).

## Re-baselining

The baseline is only as durable as the commit it names. After a history
rewrite, the diff fails and the outcome says exactly what to do:
`the recorded baseline <sha12> cannot be diffed against HEAD: <git error>.
Delete this entry from the state file to re-baseline.` Deleting the entry
(or the whole state file) costs nothing but visibility of drift since the
old baseline; nothing is generated on re-baseline.

## Not to be confused with

- **`--base` of `kronika check`** — a one-shot argument the caller picks;
  the baseline is the loop's own recorded equivalent, chosen by evidence.
- **The [state file](state.md)** — the container; the baseline is the value
  that gives it meaning.
- **A Git branch base** — baselines compare with `...` (merge-base
  semantics) but name exact commits, not refs.
