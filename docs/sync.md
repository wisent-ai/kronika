# The sync loop

`kronika sync` closes the loop the single-shot verbs leave open: `check`
audits one change and `write` regenerates one document, but nothing
remembered where documentation last agreed with the source. Sync carries
that memory in the repository itself, in two committed files, so a scheduler
can run it forever and each tick does only the work the evidence demands.
Each noun has its own page — [manifest](concepts/manifest.md),
[state](concepts/state.md), [baseline](concepts/baseline.md),
[drift](concepts/drift.md), [audit](concepts/audit.md),
[finding](concepts/finding.md),
[blocker vs warning](concepts/blocker-vs-warning.md) — and every action
below was captured running, tick by tick, in
[walkthrough-sync-cycle](walkthrough-sync-cycle.md).

## The manifest: what is maintained

`kronika.sync.json` (override with `--manifest`) is the human's declaration
of which documents are maintained from which evidence:

```json
{
  "schemaVersion": 1,
  "documents": [
    {
      "output": "docs/operations.md",
      "sources": ["src/deploy", "src/monitor"],
      "instruction": "Operator documentation; keep the existing section order."
    }
  ]
}
```

Per document: `output` is the repository-relative documentation file;
`sources` are the repository-relative files or directories that are its
evidence — and also the pathspecs drift detection filters the Git diff by;
`instruction` is a standing documentation goal passed to both the audit and
the rewrite. Each entry may also override the run's budgets: `model`,
`maxTokens`, `maxInputBytes`, `maxFileBytes`, `maxDiffBytes`; anything not
overridden comes from the CLI flags ([cli](cli.md)). `schemaVersion` must be
`1`, `documents` must be non-empty, and every entry must declare at least
one source — a manifest that fails these checks is an error, as is a
missing manifest.

## The state: what was reconciled

`kronika.sync-state.json` (override with `--state`) records, per output
path, the last commit the document was reconciled against:

```json
{
  "schemaVersion": 1,
  "documents": {
    "docs/operations.md": {
      "headSha": "<40-hex commit>",
      "syncedAt": "<ISO-8601 timestamp>",
      "lastAction": "checked-current"
    }
  }
}
```

A missing state file means no document has a baseline yet. Invalid JSON in
the state file is an error with one remedy: fix or delete it to re-baseline.
The state file is meant to be committed beside the manifest — it is the
auditable record of the loop.

## One tick

Sync resolves `HEAD` once, then decides per manifest document:

| Evidence | Action | Model calls |
|---|---|---|
| no state entry | `baseline` — record HEAD, generate nothing | none |
| state already at HEAD | `current` | none |
| no declared path changed since the baseline | `advanced` — baseline moves to HEAD | none |
| declared paths changed, audit passes | `checked-current` — baseline moves | one `check` |
| audit finds blockers | `rewritten` — document regenerated, baseline moves | `check` + `write` |
| baseline cannot be diffed, or audit/rewrite errors | `failed` — baseline does not move | varies |

Two deliberate choices define the loop:

- **Baseline before generation.** A first run that rewrote every document
  through a model would replace reviewed prose wholesale; sync maintains
  documents from the moment they enter the manifest, so the first tick only
  records where maintenance begins.
- **A passing audit IS the update.** Drift detection diffs
  `baseline...HEAD` restricted to the document's declared sources *and the
  document itself* — a hand edit to the document advances its baseline
  exactly like a source change the audit passes. The audit runs over that
  same restricted diff, so one drifted document is never blocked by the
  size of unrelated changes, and the checker's own contract is "never
  require churn merely because source changed".

When the audit does find blockers, the rewrite is not free-form: the
document is regenerated through `write --apply` with an instruction built
from the audit's own blocker findings — preserve the document's existing
structure, voice, and correct content; correct exactly the audited defects;
do not re-author sections the audit did not name.

## Failure and recovery

A `failed` outcome never advances the baseline, so the next tick retries the
same range. If the recorded baseline commit no longer exists in the
repository (rewritten history), the diff fails and the outcome says so;
delete that document's entry from the state file to re-baseline. Audit and
rewrite failures carry the underlying Brama or parsing error in their
detail. Sync exits `1` when any document failed, `0` otherwise.

## Dry run, commit, push

`--dry-run` reports and audits but writes no file and no state — a document
that would be rewritten is reported with its findings instead. Without
`--dry-run`, the state file is written only when something actually
advanced. `--commit` stages exactly the rewritten documents plus the state
file and commits (`kronika sync: reconcile <files>`, or
`kronika sync: advance documentation baselines` when only baselines moved);
`--push` pushes that commit. This makes the loop schedulable: cron, launchd,
or any scheduler can run `kronika sync --commit --push` unattended and
documentation follows the repository by itself.

One observed detail: the state records the HEAD the tick ran at, and the
sync commit itself then moves HEAD by one — so the tick after a `--commit`
reports `advanced` (a free baseline move over the sync commit), not
`current`. `current` appears only when nothing was committed between two
ticks.
