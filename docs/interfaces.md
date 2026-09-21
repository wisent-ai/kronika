<!-- Moved out of README.md on 2026-09-21: that file stood at 512 lines,
     past the three-hundred-line limit every file in this workshop lives
     under. Nothing here was rewritten. -->

## Primary interfaces

### Adopt existing documents into the project manifest

```bash
kronika init --repo /path/to/project
kronika init --repo /path/to/project --docs README.md --docs handbook \
  --source src --source package.json
```

Without `--docs`, Kronika discovers Markdown under an existing `README.md` and
`docs/`. Every document receives the exact repeated `--source` paths, or `.`
when none are supplied, in schema-version-1 `kronika.sync.json`. The command
validates all selected paths before one atomic manifest write. It reports
`imported`, `unchanged`, `conflicting`, and `rejected` arrays; a conflict or
rejection exits non-zero and leaves the current manifest untouched. `--replace`
is the explicit overwrite for a conflicting manifest. Symbolic links,
non-Markdown file selections, missing paths, and paths outside the repository
are rejected. Existing documents are never copied, generated, or edited.

### Adopt existing documents through the graphical importer

```bash
kronika gui --repo /path/to/project
```

The installed package includes the browser assets. The local workspace exposes
the same `documents`, `sources`, `manifestPath`, `instruction`, and `replace`
inputs accepted by `initializeDocumentationWorkspace`. Blank document and
source selections retain the CLI defaults. Results keep imported, unchanged,
conflicting, and rejected paths distinct; success is followed by a readback of
the actual manifest and every accepted document/source declaration. See the
[graphical importer contract](https://kronika.wisent.com/docs/gui/).

### Inspect sources

```bash
kronika sources \
  --repo /path/to/project \
  --source README.md \
  --source src \
  --source docs
```

Automatic discovery uses
`git ls-files --cached --others --exclude-standard`, then a bounded recursive
scan when the path is not a Git worktree.


### Check one exact change

```bash
kronika check \
  --repo /path/to/project \
  --base origin/main \
  --head HEAD \
  --json
```

The base and head are resolved to commit SHAs before the model call. Kronika
refuses an unreadable or oversized diff rather than auditing truncated evidence.
The JSON result contains the resolved SHAs, changed paths, summary, warnings,
and blocker findings. Exit status `1` means at least one blocker.

### Generate and preview

```bash
kronika write \
  --repo /path/to/project \
  --output docs/architecture.md \
  --source README.md \
  --source src \
  --instruction 'Document components, request flow, invariants, and failure modes.'
```

Add `--apply` only after confirming the selected source boundary and accepting a
complete replacement of the output file.

### Keep a repository's documentation reconciled

```bash
kronika sync --repo /path/to/project --commit --push
```

Sync reads `kronika.sync.json` — the human's declaration of which documents
are maintained from which evidence:

```json
{
  "schemaVersion": 1,
  "documents": [
    {
      "output": "docs/operations.md",
      "sources": ["src/deploy", "src/monitor"],
      "instruction": "Operator documentation; keep the existing section order."
    }
  ]
}
```

and records the last reconciled commit per document in
`kronika.sync-state.json`, committed beside it. Each run does only the work
the evidence demands: a document's first run records a baseline and generates
nothing; a run whose declared sources did not change advances nothing and
calls no model; a drifted document is audited (`check`) over a diff
restricted to its declared sources, and a passing audit IS the update — the
state advances without churn. Only an audit with blocker findings triggers a
rewrite (`write --apply`), instructed with those findings so the rewrite
corrects named defects instead of re-authoring reviewed text. `--dry-run`
audits without writing a file or the state; `--commit`/`--push` land the
reconciliation, so a scheduler (cron, launchd, `stado schedule`) can run the
same command forever and documentation follows the repository by itself.
Exit status `1` means at least one document failed to reconcile.

| Option | Purpose |
|---|---|
| `--model <selector>` | override the Brama selector |
| `--max-input-bytes <n>` | total source payload; default `200000` |
| `--max-file-bytes <n>` | one source file; default `64000` |
| `--max-tokens <n>` | completion budget; default `8000` |
| `--max-diff-bytes <n>` | complete Git diff budget for `check`; default `200000` |
| `--base <ref>` | required base commit for `check` |
| `--head <ref>` | head commit for `check`; default `HEAD` |
| `--timeout-ms <n>` | Brama request bound; default `120000` |
| `--json` | machine-readable result |
| `--apply` | atomically replace the requested output |

### Walk the first-use journey

```bash
kronika onboarding             # current screen
kronika onboarding --advance   # next screen
kronika onboarding --reset     # replay from the first screen
kronika onboarding --status    # report an existing attempt without starting one
kronika onboarding --json      # machine-readable screen
```

The journey is the definition the package ships
(`src/onboarding_first_use.json`): it starts with the Markdown already in the
repository and leads to `kronika init`. It needs no Brama route and completes
only after the canonical sync manifest is atomically written or an identical
manifest is accepted (`documentation_workspace_initialized`). Progress is one
local file under `${XDG_STATE_HOME:-~/.local/state}/kronika/onboarding.json`;
`--skip` dismisses the journey and `--reset` replays it.

### Brama configuration

```bash
export BRAMA_URL=https://brama.wisent.com
export BRAMA_API_KEY='<runtime-injected-client-bearer>'
# Optional when the Brama client identity is also bound to an agent:
export WISENT_APP_AGENT_ID=kronika
export WISENT_APP_AGENT_AUTH_SECRET='<runtime-injected-signing-secret>'
export KRONIKA_MODEL=any
```

`MODEL_ROUTER_URL` and `MODEL_ROUTER_TOKEN` are accepted as aliases for
`BRAMA_URL` and `BRAMA_API_KEY`. The bearer is always required. The agent ID and
HMAC secret are optional but must be supplied together. Never commit either
credential; materialize them through the deployment's scoped secret boundary.

## Library API

```ts
import { BramaClient, initializeDocumentationWorkspace, writeDocumentation } from "@wisent-ai/kronika";

const initialized = initializeDocumentationWorkspace({
  repo: "/path/to/project",
  manifestPath: "kronika.sync.json",
  documents: ["README.md", "docs"],
  sources: ["src", "package.json"],
});
if (initialized.status === "conflicting" || initialized.status === "rejected") {
  throw new Error(JSON.stringify(initialized));
}

const client = new BramaClient({
  url: process.env.BRAMA_URL!,
  apiKey: process.env.BRAMA_API_KEY!,
});

const result = await writeDocumentation({
  repo: "/path/to/project",
  output: "README.md",
  sources: ["src", "package.json"],
  instruction: "Write the canonical installation and API guide.",
  model: "any",
  maxInputBytes: 200_000,
  maxFileBytes: 64_000,
  maxTokens: 8_000,
  apply: false,
}, client);

process.stdout.write(result.content);
```

