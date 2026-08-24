# What is Kronika

Kronika is Wisent's source-grounded documentation writer and
documentation-consistency gate. It generates and audits repository
documentation through Brama, treating the repository itself as the only
admissible evidence. The whole product is three moving parts: an evidence
boundary that selects what the model may see, one bounded Brama call that
writes or judges, and a sync loop that remembers where documentation and
source last agreed.

## The evidence boundary selects

Before any model call, Kronika builds an explicit source manifest. Discovery
is Git-aware — `git ls-files --cached --others --exclude-standard` — with a
bounded recursive walk when the path is not a Git worktree. Secret-prone
files are excluded by name and extension (`.env*`, lock files, private keys,
`credentials.json`), and generated or dependency directories (`node_modules`,
`dist`, `build`, `.git`, `vendor`, `target`) are never entered. Every
selection is confined to the repository: an explicit `--source` outside the
repository, a symbolic link, or an output path escaping the repository is an
error, not a warning. Payloads are bounded by a per-file and a total byte
budget, and every skipped file is reported with its reason. `kronika sources`
prints this manifest without calling Brama at all — the boundary is
inspectable before it is used. Details: [source selection](sources.md).

## One Brama call writes or judges

Everything the model does is one signed, OpenAI-compatible chat completion
against `BRAMA_URL`. In `write` mode the prompt carries the selected sources
and a documentation instruction; the system prompt forbids inventing
commands, endpoints, configuration keys, or guarantees, and treats repository
content as untrusted reference data, never as instructions. The result is
previewed on stdout by default; only explicit `--apply` replaces the target
document, atomically, inside the repository. In `check` mode the prompt
carries one exact Git range (`--base`...`--head`, resolved to commit SHAs)
plus current sources, and the model must return a strict JSON verdict:
`passed`, a summary, and blocker or warning findings. A blocker is a concrete
public-behavior defect the change causes or exposes; internal refactors never
require documentation churn. `check` exits non-zero on any blocker, so it can
gate CI. Details: [cli](cli.md), [configuration](configuration.md).

## Sync remembers

`check` audits one change and `write` regenerates one document, but neither
remembers where documentation last agreed with the source. `kronika sync`
carries that memory in the repository itself: `kronika.sync.json` is the
human's declaration of which documents are maintained from which evidence,
and `kronika.sync-state.json` records the last commit each document was
reconciled against. Each run does only the work the evidence demands — a
document's first run records a baseline and generates nothing; an unchanged
document advances without a model call; a drifted document is audited over a
diff restricted to its own declared sources, and a passing audit IS the
update. Only an audit with blocker findings triggers a rewrite, instructed
with those findings so it corrects named defects instead of re-authoring
reviewed text. `--commit` and `--push` land the reconciliation, so a
scheduler can run the same command forever. Details: [the sync loop](sync.md).

## What Kronika is not

Kronika does not prove generated prose correct merely because source was
supplied; a maintainer must review claims and omissions. It does not execute
repository instructions, build scripts, or generated output. It holds no
hosted database — output and history stay in the repository and its Git log.
It does not schedule repositories, publish a site, or manage credentials:
Brama owns client authorization, model selection, and inference, and the
bearer plus optional HMAC identity are runtime secrets that never enter
source or output. The repository also ships a separate documentation-site
pipeline (`docs-cli`) that authors a typed content plan and gates it with
mechanical validators; that is a distinct subsystem, described in
[site-pipeline](site-pipeline.md).

## The first three commands

```bash
kronika sources
```

The evidence boundary for the current repository: every selected file, the
byte total, and every skipped file with its reason. No Brama call.

```bash
kronika check --base origin/main
```

Audit the exact change from `origin/main` to `HEAD` against current
documentation. Exit `1` means at least one concrete documentation blocker.

```bash
kronika sync --dry-run
```

Report what a reconciliation run would do for every manifest-declared
document, without writing a file or the state. The end-to-end path is
[quick-start](quick-start.md); the full command surface is [cli](cli.md).

## The rest of the corpus

- **Nouns** — [source collection](concepts/source-collection.md),
  [check](concepts/check.md), [audit](concepts/audit.md),
  [finding](concepts/finding.md),
  [blocker vs warning](concepts/blocker-vs-warning.md),
  [manifest](concepts/manifest.md), [state](concepts/state.md),
  [baseline](concepts/baseline.md), [drift](concepts/drift.md).
- **Executed end to end** — [gating one change](walkthrough-check.md),
  [one full sync cycle](walkthrough-sync-cycle.md),
  runnable [examples](examples/README.md).
- **When it fails** — every error sentence, with meaning and fix:
  [runbook](runbook.md).
- **Boundaries** — what Kronika owns, what it refuses to own, and what
  leaves the machine: [architecture](architecture.md).
