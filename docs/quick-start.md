# Quick start

How do you go from a clone to a reconciled document? This page is the one
happy path: build the CLI, inspect the evidence boundary without any model
call, configure Brama, audit one change, preview one document, and turn on
the sync loop. Everything else — the full flag surface, the selection rules,
the loop's exact state machine — lives in [cli](cli.md),
[sources](sources.md), and [sync](sync.md).

## Build the CLI

Prerequisites: Git, Node.js 22 or newer, npm.

```bash
git clone https://github.com/wisent-ai/kronika.git
cd kronika
npm install
npm run build
npm link
```

`npm run build` compiles TypeScript into `dist/`; the `kronika` binary is
`dist/src/cli.js`. `npm link` puts `kronika` on your PATH; without it, run
`node dist/src/cli.js` directly. The package has no runtime dependencies.

## Inspect the evidence boundary

```bash
kronika sources --repo /path/to/project
```

This makes no model request and changes no file — it needs no Brama
configuration at all. It prints JSON: the selected files with byte counts,
the total, and every skipped file with its reason. Captured against a toy
repository (paths and counts will differ):

```json
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
  "skipped": [
    { "path": "credentials.json", "reason": "credential or generated lock file" }
  ]
}
```

Add `--source <path>` (repeatable) to select explicit files or directories
instead of automatic discovery. Review this boundary before configuring
Brama: it is exactly what the model will see.

## Configure Brama

```bash
export BRAMA_URL=<your-brama-origin>
export BRAMA_API_KEY=<scoped-bearer>
# Optional request signing; set both or neither:
export WISENT_APP_AGENT_ID=<agent-id>
export WISENT_APP_AGENT_AUTH_SECRET=<signing-secret>
export KRONIKA_MODEL=any
```

`BRAMA_URL` and `BRAMA_API_KEY` are required for `check`, `write`, and
`sync` (`MODEL_ROUTER_URL` and `MODEL_ROUTER_TOKEN` are accepted aliases).
The agent ID and HMAC secret must be supplied together or not at all.
`KRONIKA_MODEL` sets the default `--model` selector; unset, it is `any`.
See [configuration](configuration.md).

## Audit one change

```bash
kronika check --repo /path/to/project --base origin/main --json
```

`check` resolves `--base` and `--head` (default `HEAD`) to commit SHAs,
sends the bounded Git diff plus current sources to Brama, and prints a
structured verdict. Exit `0` means the documentation already covers the
change; exit `1` means at least one blocker finding names a concrete defect
— captured blocked and passing runs are in
[walkthrough-check](walkthrough-check.md).

## Preview one document

```bash
kronika write \
  --repo /path/to/project \
  --output docs/architecture.md \
  --source README.md --source src \
  --instruction 'Document components, request flow, invariants, and failure modes.'
```

Without `--apply`, `write` prints the generated Markdown to stdout and
changes nothing. Add `--apply` only after reviewing the preview: it
atomically replaces the output file, which must stay inside the repository.

## Turn on the sync loop

Declare the maintained documents in `kronika.sync.json` at the repository
root:

```json
{
  "schemaVersion": 1,
  "documents": [
    {
      "output": "docs/architecture.md",
      "sources": ["src", "README.md"],
      "instruction": "Keep the existing section order."
    }
  ]
}
```

Then run:

```bash
kronika sync --repo /path/to/project --commit --push
```

The first run for each document records the current commit as its baseline
and generates nothing — captured verbatim:

```console
$ kronika sync --commit
Kronika sync at 39825d883997
  baseline        docs/usage.md — first sync records 39825d883997 as the baseline; nothing is generated on a first run
  committed
```

Every later run audits only documents whose declared sources changed,
rewrites only documents whose audit found blockers, and records the
reconciled commit in `kronika.sync-state.json`. `--dry-run` reports without
writing anything. Exit `1` means at least one document failed to reconcile.
The full state machine is [the sync loop](sync.md); every action, captured
tick by tick, is [walkthrough-sync-cycle](walkthrough-sync-cycle.md).
