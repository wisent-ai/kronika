# Architecture

Where does Kronika sit, what does it own, and what never crosses its
boundaries? Kronika is a client-side gate between three parties: a Git
repository (the only admissible evidence), Brama (the only model access),
and whatever consumes the documentation afterwards — CI, a scheduler, or the
separate site pipeline.

## Data flow

```text
                 repository (working tree + Git history)
                        |                    |
              collectSources             git rev-parse / diff
             (selection boundary)        (exact SHAs, bounded patch)
                        |                    |
                        v                    v
                 one prompt: system rules + file-framed sources [+ diff]
                        |
                        v
                 BramaClient — POST <BRAMA_URL>/v1/chat/completions
                 bearer + optional HMAC body signature, hard timeout
                        |
                        v
        write: Markdown  --normalize-->  preview stdout | atomic --apply
        check: JSON verdict --validate--> exit code / findings
                        ^
                        |
   sync loop: manifest + state decide, per document, whether any call
   happens at all (baseline / advanced / audit / rewrite)  — src/sync.ts
```

Every model interaction in the `kronika` CLI is exactly one chat completion
(`src/brama.ts`). There is no streaming, no tool use, no retry loop, no
second provider: if Brama does not answer, the verb fails with the
transport's own sentence ([runbook](runbook.md)).

## What Kronika owns

- **The evidence boundary.** What a prompt may contain is decided before any
  network call: Git-aware discovery, secret-prone exclusions, repository
  confinement, byte budgets — all inspectable via `kronika sources` with no
  Brama configuration at all ([concepts/source-collection](concepts/source-collection.md)).
- **The verdict contract.** Model answers are structured claims that get
  validated, not trusted: strict JSON verdicts for audits, normalized
  Markdown for rewrites (fence stripped, too-short and NUL content refused).
- **The loop's memory.** `kronika.sync.json` (intent) and
  `kronika.sync-state.json` (progress) live in the target repository and are
  meant to be committed; the audit trail is the Git log itself
  ([concepts/manifest](concepts/manifest.md), [concepts/state](concepts/state.md)).
- **Atomicity of the one write it performs.** `--apply` writes a temporary
  file beside the target and renames it into place, preserving mode; a
  failed write leaves the old document intact (`src/writer.ts`).

## What Kronika does not own

- **Model routing, authorization, inference.** Brama's job. Kronika sends a
  `model` selector string (default `any`) and credentials from the
  environment; it never talks to a provider, holds no key store, and has no
  fallback endpoint ([configuration](configuration.md)).
- **Scheduling.** `kronika sync --commit --push` is designed to be run by
  cron, launchd, or CI; Kronika keeps no daemon, no queue, no clock.
- **Truth of prose.** A passing audit means the model found no blocker in
  the supplied evidence — a maintainer still reviews claims and omissions.
- **Publishing.** The site pipeline (`docs-cli`, under `pipeline/`) is a
  separate subsystem with its own inputs (`docs-sources.json`), its own
  endpoint resolution (`BRAMA_URL`, else the local resolver adapter at
  `http://127.0.0.1:17601`), its own validators, and its own exit codes —
  it shares the repository and Brama, not code paths
  ([site-pipeline](site-pipeline.md)).
- **Execution of repository content.** Kronika reads files and runs `git`;
  it never runs the repository's build, tests, or scripts. (The pipeline's
  drift validator runs only the declared product binary with subcommand
  words plus `--help`/`--version`, allowlisted, never shell-interpreted.)

## Trust boundaries

| Boundary | Rule |
|---|---|
| repository → prompt | Untrusted reference data. Both system prompts instruct the model to ignore instructions embedded in sources and diffs (prompt-injection stance), and to never reproduce credentials, tokens, keys, personal data, or private infrastructure addresses. |
| repository → selection | Secret-prone names never selected; symlinks never followed; nothing outside the repository root read or written. |
| environment → request | `BRAMA_API_KEY` rides only in the `authorization` header; the optional HMAC pair signs `agentId:timestamp:sha256(body)` so the signature commits to the exact payload. Secrets never enter prompts, output, manifest, or state. |
| model → repository | Only through validation: verdicts parsed field by field; rewrites normalized and refused when degenerate; only `--apply`/sync-rewrite writes, atomically, inside the repository. |
| sync → Git history | `--commit` stages exactly the rewritten documents plus the state file; `--push` pushes that one commit. Kronika never force-pushes, rebases, or edits history. |

## What leaves the machine

One POST per model call to `BRAMA_URL`, containing: the repository's base
name, the instruction, the selected file manifest and contents, and for
audits the resolved SHAs and the bounded diff. Budgets cap it:
`--max-file-bytes`, `--max-input-bytes`, `--max-diff-bytes`. Nothing else is
transmitted, and `kronika sources` shows the exact file list beforehand.

## Failure posture

Fail closed, loudly, in one line: every error is `kronika: <message>` on
stderr with exit `1`. Oversized diffs are refused rather than truncated;
contradictory verdicts are refused rather than reinterpreted; a failed sync
document keeps its [baseline](concepts/baseline.md) so the next tick retries
the same range. The complete sentence inventory is the
[runbook](runbook.md).
