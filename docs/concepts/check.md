# Check

Should this change merge? A check is Kronika's gate verb: one
[audit](audit.md) of one exact Git range, turned into an exit code a CI job
can key on. `kronika check` is the only command whose success depends on a
model's verdict — and it is wired so that a broken verdict blocks exactly
like a failed one.

## What it is

`kronika check --base <ref> [--head <ref>]` runs exactly one audit
(`src/cli.ts` → `checkDocumentation`):

- `--base` is required and has no default — the caller names the point the
  change is measured from. `--head` defaults to `HEAD`.
- Both refs are resolved to commit SHAs before anything else; the SHAs, not
  the moving refs, appear in the prompt and the result.
- The audited diff is the three-dot range `base...head` — changes since the
  merge base, so a branch is judged only on what it adds.
- The whole range is in scope: bare `check` passes no pathspec restriction,
  so every changed path is audited against every selected source. (The
  [sync loop](../sync.md) reuses the same audit with `diffPaths` restricted
  to one document's declared evidence — that restriction is sync's, not
  check's.)

## Lifecycle

1. Parse flags; `check requires --base <ref>` is refused before anything
   runs.
2. Require `BRAMA_URL`/`BRAMA_API_KEY` (or their `MODEL_ROUTER_*` aliases)
   from the environment ([configuration](../configuration.md)).
3. Collect the [source collection](source-collection.md) and resolve the
   range; refuse an oversized diff rather than truncate it.
4. One completion through Brama; validate the verdict field by field
   ([finding](finding.md)).
5. Print, then exit: `0` exactly when the validated verdict has no
   [blocker](blocker-vs-warning.md); `1` on blockers **or any failure**.

## Output

Text output is the verdict line, the summary, and one line per finding —
captured against a toy repository with a scripted verdict:

```console
$ kronika check --base HEAD~1
Kronika documentation check: BLOCKED
src/greet.js adds a --shout flag that docs/usage.md does not mention.
  - blocker: The new --shout flag changes the public CLI surface and is absent from docs/usage.md.
```

`--json` pins the audit to its coordinates — exact SHAs, changed paths,
diff size, source count — so a gate's decision is reproducible from its own
record:

```json
{
  "passed": false,
  "summary": "src/greet.js adds a --shout flag that docs/usage.md does not mention.",
  "findings": [ { "severity": "blocker", "code": "undocumented-flag", "...": "..." } ],
  "model": "stub/dokument-1",
  "baseSha": "3520b2d97e40a9613d083361b38bfaddb11084a2",
  "headSha": "9486e1b31a66425588612a10236a371e4125038a",
  "changedPaths": ["docs/usage.md", "kronika.sync-state.json", "src/greet.js"],
  "diffBytes": 1104,
  "sourceCount": 5,
  "skipped": [{ "path": "credentials.json", "reason": "credential or generated lock file" }]
}
```

The full field list is in [cli](../cli.md#kronika-check); a blocked and a
passing run end to end are in [walkthrough-check](../walkthrough-check.md).

## The gate never fails open

Exit `1` covers every non-passing outcome, deliberately: blocker findings,
an unresolvable ref, an oversized diff, an unreachable Brama, a timeout, a
verdict that is not valid JSON, and a verdict whose `passed` contradicts
its own blockers. A CI job therefore needs no error handling beyond the
exit status:

```bash
kronika check --repo . --base "origin/${GITHUB_BASE_REF:-main}" --json
```

Runnable version: [examples/gate-a-change.sh](../examples/gate-a-change.sh).
[Warnings](blocker-vs-warning.md) print but never gate — a passing verdict
with warnings still exits `0`.

## Refusals

Exact sentences, captured; every one is in the [runbook](../runbook.md):

```console
$ kronika check
kronika: check requires --base <ref>
$ kronika check --base
kronika: --base requires a value
$ kronika check --base deadbeef
kronika: Git commit cannot be resolved: deadbeef
$ kronika check --base HEAD~1 --max-diff-bytes 1
kronika: Git diff is 359 bytes, above --max-diff-bytes 1; narrow or split the change rather than auditing a truncated diff
```

Transport, environment, and verdict-validation failures surface their own
sentences (`fetch failed`, `Brama request timed out after <n>ms`,
`Kronika returned invalid documentation-check JSON`, …) — all exit `1`.

## Not to be confused with

- **The [audit](audit.md)** — the underlying comparison and verdict
  contract; check is the CLI verb that runs one and turns it into an exit
  code.
- **Sync's `checked-current`** — the same audit run by the loop, restricted
  to one document's declared evidence, whose pass advances a
  [baseline](baseline.md) instead of exiting.
- **`kronika sources`** — shows what a check would read, but runs no audit
  and needs no Brama configuration.
