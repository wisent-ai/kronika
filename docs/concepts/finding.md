# Finding

An [audit](audit.md) that merely said "failed" would leave a rewrite free to
re-author everything. A finding is the unit that prevents that: one named,
evidence-grounded documentation defect (or observation), specific enough to
be corrected without touching anything else.

## Shape

Every finding in a verdict is validated field by field (`src/checker.ts`):

| Field | Type | Rule |
|---|---|---|
| `severity` | `"blocker"` \| `"warning"` | nothing else parses |
| `code` | string | stable kebab-case, `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `document` | string \| null | repository-relative documentation path, or null when no single document owns the defect |
| `sourcePaths` | string[] | the changed paths that ground the finding |
| `message` | string | the specific defect; must be non-empty |
| `requiredChange` | string \| null | the specific documentation correction, or null |

A captured blocker, verbatim from `kronika check --json`:

```json
{
  "severity": "blocker",
  "code": "undocumented-flag",
  "document": "docs/usage.md",
  "sourcePaths": ["src/greet.js"],
  "message": "The new --shout flag changes the public CLI surface and is absent from docs/usage.md.",
  "requiredChange": "Document the --shout flag: it upper-cases the greeting."
}
```

## Blocker vs warning

The severity split carries the whole gating semantics:

- **Blocker** — a concrete defect caused or exposed by the audited change: a
  changed public command, API, configuration key, workflow, security
  boundary, operational requirement, compatibility promise, or product
  behavior that the current documentation omits or contradicts. Blockers
  fail the audit: `check` exits `1`, and in sync they become the rewrite
  brief.
- **Warning** — useful but non-blocking. Warnings are reported in the
  verdict and printed, and nothing else: they never flip `passed`, never
  fail `check`, never trigger a rewrite.

The verdict-level invariant is mechanical: `passed` must equal "there are no
blocker findings", or the whole verdict is rejected with
`Kronika documentation check contradicts its blocker findings`.

## What blockers become

In the [sync loop](../sync.md), a blocked audit's blockers are compiled into
the rewrite instruction (`src/sync.ts`), one line each:

```text
- [<code>] <message> Required change: <requiredChange>
```

prefixed by the document's standing manifest instruction and the fixed
constraint: *preserve the document's existing structure, voice, and correct
content; correct exactly the audited defects below; do not re-author
sections the audit did not name*. Warnings are deliberately excluded from
the brief.

## Refusals

A verdict with a malformed finding is rejected whole. Exact sentences, where
`<i>` is the finding's index:

- `Kronika finding <i> is not an object`
- `Kronika finding <i> has invalid severity`
- `Kronika finding <i> has invalid code`
- `Kronika finding <i> has invalid document`
- `Kronika finding <i> has invalid sourcePaths`
- `Kronika finding <i> has no message`
- `Kronika finding <i> has invalid requiredChange`

## Not to be confused with

- **The summary** — the verdict's one-line narrative; findings are the
  actionable units, and only findings drive rewrites.
- **A skipped source** — a [source-collection](source-collection.md)
  exclusion with a reason; not a documentation defect.
- **A `failed` sync outcome** — an audit or rewrite that did not complete
  ([state](state.md)); findings exist only inside completed verdicts.
