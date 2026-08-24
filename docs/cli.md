# CLI reference

One binary, four commands:

```text
kronika sources [options]
kronika check --base <ref> [options]
kronika write [options]
kronika sync [options]
```

`kronika` with no arguments, `help`, `-h`, or `--help` prints usage. An
unknown command or option is an error. Every error is written to stderr as
`kronika: <message>` with exit status `1`; the complete sentence inventory,
with what each means, is the [runbook](runbook.md).

`sources` reads no Brama configuration. `check`, `write`, and `sync` require
`BRAMA_URL` (or `MODEL_ROUTER_URL`) and `BRAMA_API_KEY` (or
`MODEL_ROUTER_TOKEN`) in the environment; see
[configuration](configuration.md).

| Command | Exit `0` | Exit `1` |
|---|---|---|
| `sources` | manifest printed | selection refused (outside repo, symlink, missing path) |
| `check` | audit passed — no blockers | blockers found, or any failure |
| `write` | preview printed / document applied | any failure |
| `sync` | every document reconciled | any `failed` outcome, or any failure |

## Options

One parser serves all commands; flags irrelevant to a command are accepted
but unused.

| Option | Default | Purpose |
|---|---|---|
| `--repo <path>` | current directory | repository root |
| `--output <path>` | `README.md` | target document inside the repository |
| `--source <path>` | automatic discovery | explicit source file or directory; repeatable |
| `--base <ref>` | — | base Git commit for `check` (required there) |
| `--head <ref>` | `HEAD` | head Git commit for `check` |
| `--instruction <text>` | — | additional documentation goal |
| `--model <selector>` | `KRONIKA_MODEL` or `any` | Brama model selector |
| `--max-input-bytes <n>` | `200000` | total source budget |
| `--max-file-bytes <n>` | `64000` | per-file source limit |
| `--max-tokens <n>` | `8000` | completion token budget |
| `--max-diff-bytes <n>` | `200000` | Git diff budget for `check` |
| `--timeout-ms <n>` | `120000` | Brama request timeout |
| `--apply` | off | atomically replace the target document (`write`) |
| `--manifest <path>` | `kronika.sync.json` | sync manifest inside the repository |
| `--state <path>` | `kronika.sync-state.json` | sync state file inside the repository |
| `--dry-run` | off | sync: report and audit, but write no file and no state |
| `--commit` | off | sync: commit rewritten documents and the state file |
| `--push` | off | sync: push the sync commit |
| `--json` | off | machine-readable result |

Numeric flags must be positive integers
(`<flag> must be a positive integer`); a value-taking flag without a value
is `<flag> requires a value`.

## kronika sources

Prints the safe source manifest without calling Brama:

```json
{
  "repo": "...",
  "output": "README.md",
  "totalBytes": 12345,
  "sources": [{ "path": "src/cli.ts", "bytes": 13300 }],
  "skipped": [{ "path": ".env", "reason": "credential or generated lock file" }]
}
```

The collection's shape, lifecycle, and refusal sentences are in
[concepts/source-collection](concepts/source-collection.md); the full
selection and exclusion rules in [sources](sources.md). Exit `0` unless
selection itself fails (source outside the repository, symbolic link,
missing path).

## kronika check

Audits one exact Git change against current documentation. `--base` is
required; `--base` and `--head` are resolved to commit SHAs
(`git rev-parse --verify <ref>^{commit}`) before the model call. The diff is
taken with `--unified=40 --find-renames` over `base...head`; a diff larger
than `--max-diff-bytes` is refused with an error rather than audited
truncated. The model must answer with a strict JSON verdict; a malformed
verdict, or a `passed` value that contradicts its own blocker findings, is
an error.

Text output is `Kronika documentation check: PASSED` or `BLOCKED`, the
summary, and one line per finding. `--json` emits:

```json
{
  "passed": false,
  "summary": "...",
  "findings": [
    {
      "severity": "blocker",
      "code": "stable-kebab-case-code",
      "document": "docs/cli.md",
      "sourcePaths": ["src/cli.ts"],
      "message": "...",
      "requiredChange": "..."
    }
  ],
  "model": "...",
  "baseSha": "...",
  "headSha": "...",
  "changedPaths": ["src/cli.ts"],
  "diffBytes": 4213,
  "sourceCount": 12,
  "skipped": []
}
```

Exit `0` when the audit passes (no blockers); exit `1` when it reports a
blocker or fails — the gate never fails open. Warnings never block. The
audit contract itself — "never require churn merely because source
changed" — is enforced by the system prompt in `src/checker.ts`; the
verdict and finding vocabulary are [concepts/check](concepts/check.md),
[concepts/audit](concepts/audit.md),
[concepts/finding](concepts/finding.md), and
[concepts/blocker-vs-warning](concepts/blocker-vs-warning.md). A blocked and a passing run,
captured end to end, are in [walkthrough-check](walkthrough-check.md).

## kronika write

Generates one complete Markdown document through Brama from the selected
sources and `--instruction`. Without `--apply` it prints the candidate to
stdout and changes no file. With `--apply` it atomically replaces
`--output`: the content is written to a temporary file beside the target and
renamed into place, preserving the existing file mode. The output path must
stay inside the repository. Model output is normalized — a surrounding
Markdown code fence is stripped, content under 20 characters or containing
NUL is rejected — and always ends with a newline.

`--json` emits `outputPath`, `applied`, `model`, `sourceCount`, `skipped`,
and, when not applied, the full `content`. The applied confirmation line is
`Wrote <path> from <n> source files via Brama.`

## kronika sync

Reconciles every document declared in the sync manifest with the repository:
audits drifted ones, rewrites only audited defects, and records the
reconciled commit. The full state machine is [the sync loop](sync.md).

Text output is one header line, `Kronika sync at <sha12>` (plus `(dry run)`),
then one line per document: its action (`baseline`, `current`, `advanced`,
`checked-current`, `rewritten`, `failed`) and detail. `--json` emits
`headSha`, `dryRun`, `committed`, `stateWritten`, and the full `outcomes`
array with changed paths and findings.

With `--commit` (and not `--dry-run`), sync stages the rewritten documents
plus the state file and commits with the message
`kronika sync: reconcile <files>` — or
`kronika sync: advance documentation baselines` when only baselines moved.
`--push` then runs `git push`. Exit `0` when every document reconciled;
exit `1` when any outcome is `failed`.

One observed consequence of `--commit`: the sync commit itself moves HEAD
past the recorded baselines, so the *next* tick reports `advanced` (a free
baseline move over the sync commit), not `current`. Every action of the
state machine, with output captured tick by tick, is in
[walkthrough-sync-cycle](walkthrough-sync-cycle.md).
