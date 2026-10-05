<!-- Moved out of README.md, which had passed the three-hundred-line limit
     every file in this workshop lives under. Nothing here was rewritten. -->

## Primary interfaces

A command line Kronika cannot read — an unknown command or option, a missing
or invalid flag value — prints the refusal and the help on stderr and exits
`2`. Exit status `1` is reserved for a well-formed command that failed or
found a blocker.

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
  --source docs \
  --max-input-bytes N --max-file-bytes N
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
  --max-input-bytes N --max-file-bytes N --max-diff-bytes N \
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
  --max-input-bytes N --max-file-bytes N \
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

Kronika assumes no budget. A command that reads sources is refused by name
until `--max-input-bytes` and `--max-file-bytes` are given (`check` also needs
`--max-diff-bytes`). In sync each document may state `maxInputBytes`,
`maxFileBytes`, `maxDiffBytes`, `maxTokens` and `model` in the manifest; the
matching flag covers documents that do not. A drifted document with an
unstated byte budget fails with the missing field named, and the other
documents still reconcile.

| Option | Purpose |
|---|---|
| `--model <selector>` | override the Brama selector |
| `--max-input-bytes <n>` | total source payload; required by `sources`, `check` and `write` |
| `--max-file-bytes <n>` | one source file; required by `sources`, `check` and `write` |
| `--max-tokens <n>` | completion budget; unset, no budget is sent and the Brama alias's own output limit applies |
| `--max-diff-bytes <n>` | complete Git diff budget; required by `check` |
| `--base <ref>` | required base commit for `check` |
| `--head <ref>` | head commit for `check`; default `HEAD` |
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
export BRAMA_URL=<the Brama address this machine dials>
export BRAMA_API_KEY_ROLE='<bearer role>#bearer'
# Optional when the Brama client identity is also bound to an agent:
export WISENT_APP_AGENT_ID=<agent id>
export WISENT_APP_AGENT_AUTH_SECRET_ROLE='<signing role>#signing_secret'
export KRONIKA_MODEL=any
```

`MODEL_ROUTER_URL` is accepted for `BRAMA_URL`. No Brama address is built in:
the site pipeline falls back to the address Stado's service directory publishes
for this machine in `~/.stado/forwards/brama.local`, and the CLI requires one of
the two variables. The two `_ROLE` variables are role references `ROLE#FIELD`,
never secrets and never item names: the CLI reads each value with
`stado credentials get --role ROLE --field FIELD` (`STADO_BIN` names another
executable), so no bearer or signing secret sits in the environment or argv, and
replacing the vault item changes nothing here. The bearer reference is always
required; the agent ID and signing-secret reference are optional but go
together. A missing reference, one that is not `ROLE#FIELD`, a failed read or
an empty field is refused with the variable and the cause.

Without Brama, `BRAMA_URL` names any OpenAI-compatible provider and
`BRAMA_API_KEY_ROLE` its key; with `WISENT_APP_AGENT_ID` unset the requests go
unsigned. Without Stado, `KRONIKA_CREDENTIALS_FILE` names an owner-only
(mode 600) JSON file of role → field → value, and every `_ROLE` is answered from
it instead of `stado credentials get`; a file other users can read is refused,
and a missing `stado` executable is answered with the name of this variable.

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
  apiKey: bearerFromYourSecretBoundary,
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

