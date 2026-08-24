# Walkthrough: gating one change

A branch changed the public CLI surface — does the documentation still hold?
This page runs `kronika check` over one exact change, blocked and passing,
text and JSON, plus the refusals you will actually meet, all output pasted
verbatim. The gate verb is [concepts/check](concepts/check.md); the audit's
contract is [concepts/audit](concepts/audit.md); the finding vocabulary is
[concepts/finding](concepts/finding.md) and
[concepts/blocker-vs-warning](concepts/blocker-vs-warning.md).

**How this was captured.** Same setup as
[walkthrough-sync-cycle](walkthrough-sync-cycle.md): built CLI, toy
repository under `/tmp`, placeholder credentials. Transport and Git
refusals use the product's own offline paths (closed local port); the two
verdicts come from a local stub answering `/v1/chat/completions` with
scripted JSON — the parsing and validation exercised are Kronika's real
code, the verdict prose is canned and marked.

## The change

`src/greet.js` gained a `--shout` flag in the head commit;
`docs/usage.md` does not mention it. The audit range is one commit:

```bash
kronika check --base HEAD~1
```

`--head` defaults to `HEAD`; both are resolved to SHAs before anything else.

## Inspect the evidence first (no Brama)

```console
$ kronika sources
{
  "repo": "/private/tmp/kronika-docs.OnmsmX/toy",
  "output": "README.md",
  "totalBytes": 442,
  "sources": [
    { "path": "README.md", "bytes": 87 },
    { "path": "docs/usage.md", "bytes": 80 },
    { "path": "src/greet.js", "bytes": 93 },
    { "path": "kronika.sync.json", "bytes": 182 }
  ],
  "skipped": []
}
```

This is exactly the file set the audit will see beside the diff
([concepts/source-collection](concepts/source-collection.md)).

## Blocked (stub verdict)

```console
$ kronika check --base HEAD~1
Kronika documentation check: BLOCKED
src/greet.js adds a --shout flag that docs/usage.md does not mention.
  - blocker: The new --shout flag changes the public CLI surface and is absent from docs/usage.md.
```

Exit `1` — the shape CI keys on. The machine-readable form:

```console
$ kronika check --base HEAD~1 --json
{
  "passed": false,
  "summary": "src/greet.js adds a --shout flag that docs/usage.md does not mention.",
  "findings": [
    {
      "severity": "blocker",
      "code": "undocumented-flag",
      "document": "docs/usage.md",
      "sourcePaths": ["src/greet.js"],
      "message": "The new --shout flag changes the public CLI surface and is absent from docs/usage.md.",
      "requiredChange": "Document the --shout flag: it upper-cases the greeting."
    }
  ],
  "model": "stub/dokument-1",
  "baseSha": "ae467f145f80b713915290c5c24e313ce87e13b5",
  "headSha": "9d577cd6dad04c7c9de7d77fc0d3e1169025d36a",
  "changedPaths": ["src/greet.js"],
  "diffBytes": 456,
  "sourceCount": 5,
  "skipped": []
}
```

Note what the result pins down: exact SHAs, the changed paths, the diff
size, and how many sources were supplied — the audit is reproducible from
its own record.

## Passing (stub verdict)

After the documentation covers the flag:

```console
$ kronika check --base HEAD~1
Kronika documentation check: PASSED
docs/usage.md already documents the changed greeting behavior; no public surface is missing.
```

Exit `0`. Warnings, had there been any, would print but not gate.

## As a CI gate

```bash
kronika check --repo . --base "origin/${GITHUB_BASE_REF:-main}" --json
```

Exit `0` merges, exit `1` blocks with named findings in the log. The
three-dot diff means only the branch's own changes are audited. Runnable
version: [examples/gate-a-change.sh](examples/gate-a-change.sh).

## The refusals you will meet

All captured; every sentence is in the [runbook](runbook.md).

An oversized diff is refused, never truncated:

```console
$ kronika check --base HEAD~1 --max-diff-bytes 1
kronika: Git diff is 456 bytes, above --max-diff-bytes 1; narrow or split the change rather than auditing a truncated diff
```

A ref that is not a commit here:

```console
$ kronika check --base deadbeef
kronika: Git commit cannot be resolved: deadbeef
```

Brama unreachable (closed port — the offline evidence path):

```console
$ kronika check --base HEAD~1
kronika: fetch failed
```

Too slow for the budget:

```console
$ kronika check --base HEAD~1 --timeout-ms 1
kronika: Brama request timed out after 1ms
```

And a verdict that fails validation is an error, not a pass — captured by
scripting the stub to answer prose and a self-contradicting verdict:

```console
kronika: Kronika returned invalid documentation-check JSON
kronika: Kronika documentation check contradicts its blocker findings
```

Each of these exits `1`, so a broken audit blocks like a failed one; the
gate cannot fail open.
