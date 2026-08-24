# Blocker vs warning

Which defects stop a merge, and which are just worth hearing about? Every
[finding](finding.md) carries one of exactly two severities, and that split
carries the whole gating semantics: blockers gate and drive rewrites;
warnings inform and do nothing else.

## The standard

The definition lives in the audit's system prompt (`src/checker.ts`) and is
the contract every verdict is held to:

- A **blocker** is a concrete documentation defect caused or exposed by
  this change: a changed public command, API, configuration key, workflow,
  security boundary, operational requirement, compatibility promise, or
  product behavior that the current documentation omits or contradicts.
- A **warning** is useful but non-blocking.
- Internal refactors, formatting, implementation details, and unchanged
  public behavior do not require documentation updates — "never require
  churn merely because source changed".

## What each severity does

| | Blocker | Warning |
|---|---|---|
| flips `passed` | yes — any blocker makes the verdict fail | never |
| [`check`](check.md) exit code | `1` | unaffected |
| [sync](../sync.md) escalation | becomes the rewrite brief | none — `checked-current` still advances |
| printed | `  - blocker: <message>` | `  - warning: <message>` |

A passing verdict with a warning, captured — exit `0`, the warning printed
and nothing gated:

```console
$ kronika check --base HEAD~1
Kronika documentation check: PASSED
docs/usage.md already documents the changed greeting behavior; no public surface is missing.
  - warning: The sample output in docs/usage.md predates the --shout flag; refreshing it would help, but no public behavior is misdocumented.
```

A blocked verdict, captured — exit `1`:

```console
$ kronika check --base HEAD~1
Kronika documentation check: BLOCKED
src/greet.js adds a --shout flag that docs/usage.md does not mention.
  - blocker: The new --shout flag changes the public CLI surface and is absent from docs/usage.md.
```

## What blockers become

In the sync loop, blockers — and only blockers — are compiled into the
rewrite instruction (`rewriteInstruction`, `src/sync.ts`); the brief's
exact line format is in [finding](finding.md#what-blockers-become).
Warnings are deliberately excluded: a rewrite corrects named defects, and
a warning names none.

## Claimed by the model, enforced by Kronika

Severity arrives in the model's verdict, but Kronika validates rather than
trusts it, with two mechanical rules:

- The value must be exactly `"blocker"` or `"warning"` — anything else
  rejects the whole verdict:

  ```console
  kronika: Kronika finding 0 has invalid severity
  ```

- `passed` must equal "there are no blocker findings". A verdict that says
  `passed: true` while listing a blocker is refused, not reinterpreted:

  ```console
  kronika: Kronika documentation check contradicts its blocker findings
  ```

Both sentences were captured by scripting a stub verdict; both exit `1`, so
a misclassifying model cannot sneak a defect past the gate — the gate
[never fails open](check.md#the-gate-never-fails-open).

## Not to be confused with

- **A `failed` sync outcome** — an audit or rewrite that did not complete
  ([state](state.md)); severities exist only inside completed verdicts.
- **A skipped source** — a [source-collection](source-collection.md)
  exclusion with a reason, not a defect.
- **The summary** — the verdict's narrative line; only findings carry
  severity, and only blockers act.
