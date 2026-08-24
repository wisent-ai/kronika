# Drift

When must the loop spend a model call? Only when the evidence says the
question is open. Drift is that trigger: at least one path changed between a
document's [baseline](baseline.md) and `HEAD`, restricted to what the
[manifest](manifest.md) declares as that document's evidence — plus the
document itself.

## What it is

Per document, one Git question (`changedPathsFor`, `src/sync.ts`):

```text
git diff --name-only --find-renames <baseline>...<HEAD> -- <sources...> <output>
```

- Three-dot range: changes since the merge base, so drift measures what this
  history added, not what it merged past.
- `--find-renames`: a moved source file is one rename, not a delete plus an
  unrelated add.
- The pathspecs are the entry's `sources` **and its `output`** — a hand edit
  to the document is drift too, and it advances the baseline exactly like a
  source change the audit passes.

An empty answer is the `advanced` action: baseline moves, no model call.
A non-empty answer escalates to an [audit](audit.md) whose diff is
restricted to the same pathspecs (`diffPaths`), and the changed paths are
carried into the outcome as `changedPaths`.

## Why the restriction matters

Two properties fall out of filtering by declared evidence:

- **No hostage-taking.** One drifted document is never blocked by the size
  of unrelated changes elsewhere in the repository: its audited diff
  contains only its own evidence, so `--max-diff-bytes` measures the
  relevant change, not the repository's week.
- **No churn.** A change outside every declared source moves baselines for
  free. Captured verbatim — a README edit under a manifest that declares
  only `src`:

```text
Kronika sync at 6d6a223d5b73
  advanced        docs/usage.md — no evidence path changed in the range; baseline advanced without a model call
```

The complement is the discipline it imposes: evidence not declared in
`sources` is invisible to drift. If `docs/usage.md` documents behavior of
`config/defaults.json` but declares only `src`, a config change never
triggers an audit. Declare everything the document makes claims about.

## Drift is not a verdict

Drift answers *whether* to look, never *what is wrong*. The audit may well
pass — a comment-only change drifts, and the pass is the update:

```text
Kronika sync at 1d5ccd2b41d0
  checked-current docs/usage.md — audit passed: docs/usage.md already documents the changed greeting behavior; no public surface is missing.
```

This is the checker's contract stated in its own system prompt: internal
refactors, formatting, implementation details, and unchanged public behavior
do not require documentation updates; never require churn merely because
source changed.

## Failure modes

Drift computation needs both endpoints to exist. A baseline that cannot be
diffed (rewritten history, fabricated SHA) yields a `failed` outcome whose
detail embeds Git's own error and the remedy — delete the entry to
re-baseline ([state](state.md)). There is no other drift failure: the
question is pure Git, no model, no network.

## Not to be confused with

- **The [audit](audit.md)** — drift is "something declared changed"; the
  audit is "and here is what it means for the documentation".
- **`changedPaths` in a check result** — same mechanism, one-shot scope:
  `check` reports the paths of its explicit range, drift reports them per
  document per tick.
- **The site pipeline's drift validator** — a different subsystem's check
  that documented CLI usage matches a live binary's `--help`
  ([site-pipeline](../site-pipeline.md)).
