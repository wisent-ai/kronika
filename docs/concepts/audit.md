# Audit

Did this exact change leave the documentation complete and truthful? An
audit is Kronika's answer: one bounded comparison of one Git range against
the repository's current documentation and sources, returned as a strict,
machine-checked verdict. `kronika check` runs one audit directly; the
[sync loop](../sync.md) runs one per drifted document.

## What it is

An audit is built from two inputs and answered by one model call
(`src/checker.ts`):

- **The change** — `--base` and `--head` resolved to commit SHAs
  (`git rev-parse --verify <ref>^{commit}`), the changed paths
  (`git diff --name-status --find-renames base...head`), and the patch
  (`git diff --unified=40 --no-ext-diff --no-color --find-renames`).
  The three-dot range diffs against the merge base, so an audit of a branch
  sees only that branch's changes. When `diffPaths` is set — sync passes the
  document's declared sources plus the document itself — both diffs are
  restricted to those pathspecs.
- **The present** — a [source collection](source-collection.md) of the
  repository as it is now.

The verdict is one JSON object: `passed` (boolean), `summary` (non-empty
string), `findings` ([finding](finding.md) array). The system prompt defines
the standard: a blocker is a concrete documentation defect caused or exposed
by this change; internal refactors, formatting, and unchanged public
behavior never require updates; "never require churn merely because source
changed".

## Lifecycle

1. Validate the diff budget (`Diff byte limit must be a positive integer`).
2. Collect sources; resolve refs; take both diffs.
3. Refuse an oversized diff — refused, never truncated, because a truncated
   diff audits a change that did not happen.
4. One completion through the [Brama client](../configuration.md).
5. Parse and validate the verdict field by field; a `passed` value that
   contradicts its own blocker findings is an error, not a pass.
6. `check` exits `0` on pass, `1` on blockers or any failure; sync maps the
   verdict to `checked-current` or a rewrite ([baseline](baseline.md)).

## Invariants

- The audited range is exact: SHAs, not moving refs, appear in the prompt
  and in the result (`baseSha`, `headSha`).
- The verdict is trusted only after validation: JSON only (one surrounding
  code fence is tolerated), every finding well-formed, kebab-case codes,
  `passed === (blockers === 0)`.
- A passing audit asserts the documentation already covers the change — in
  sync, that assertion *is* the update; no file is touched.
- Repository content and diffs are supplied as untrusted reference data; the
  system prompt instructs the model to ignore instructions embedded in them.
- Warnings are reported but never gate: exit codes and rewrites key on
  blockers alone.

## Refusals

Exact sentences, captured against a toy repository:

```text
kronika: Git commit cannot be resolved: deadbeef
kronika: Git diff is 456 bytes, above --max-diff-bytes 1; narrow or split the change rather than auditing a truncated diff
kronika: Kronika returned invalid documentation-check JSON
kronika: Kronika documentation check contradicts its blocker findings
```

Plus, from `src/checker.ts`: `Git diff cannot be read for <base>...<head>`,
`Kronika documentation check is not an object`, `… has no boolean passed
field`, `… has no summary`, `… has no findings array`, and the per-finding
sentences listed in [finding](finding.md). Transport failures surface the
[Brama client's](../runbook.md#transport-and-brama-answers) own sentences.

## Not to be confused with

- **[`kronika check`](check.md)** — the CLI verb that runs exactly one audit
  and turns its verdict into an exit code; the audit is the underlying
  comparison, reused verbatim by sync with restricted `diffPaths`.
- **[Drift](drift.md)** — the cheap Git-only question "did declared evidence
  change at all?". Drift decides *whether* an audit runs; the audit decides
  what the change *means* for the documentation.
- **A rewrite** — `write` guided by audit findings. The audit never edits;
  see [baseline](baseline.md) for when sync escalates to a rewrite.
