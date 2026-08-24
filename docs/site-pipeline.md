# Site pipeline

Beyond single-document writing, the repository ships a documentation-site
pipeline (`pipeline/`, the `docs-cli` binary): turn a product repository
into its documentation site's content, then hold every page to mechanical
checks before anything publishes. The model authors a typed content plan —
never markup — and everything around the model is deterministic and
verifiable. This subsystem is independent of the `kronika` CLI and
[sync loop](sync.md).

## Stages

`pipeline/src/run.mjs` orchestrates detect → author (or load a plan) →
validate → emit, stops at the first failing stage, and prints one final
JSON report:

```bash
node pipeline/src/run.mjs <productRepo> --sources <file> [--plan <file>] [--out <dir>] [--model <selector>]
```

Exit codes: `0` all green, `1` a stage failed, `2` usage error, `69` model
infrastructure down. Each stage also runs standalone via the npm scripts
`docs:detect`, `docs:validate`, and `docs:emit`.

## Detect

`pipeline/src/detect.mjs` reads the product repository's `docs-sources.json`
— which must declare `product` and may declare `binary`, `routes`, `config`,
`changelog`, `limits`, and a `docs` map of plain evidence documents — probes
each declared surface, and computes `brief.json`. Detection never invents a
surface; only declared, probed surfaces count. The completion-gate formula:

| Evidence | Required page kinds |
|---|---|
| always | `overview` |
| CLI binary answers `--help` | `quick-start`, `cli-reference` |
| HTTP route file readable | `api-reference` |
| configuration document exists | `config-reference` |
| CHANGELOG exists | `changelog`; plus `migration` iff breaking entries |
| declared limits/quotas exist | `limits` |

## Author

The model authors `plan.json` through Brama, conforming to the closed
schema in `pipeline/schemas/plan.schema.json`. The authoring prompt is built
from `brief.json`, the declared sources, and
`pipeline/WRITING-STANDARD.md` — the injected writing standard. The endpoint
is `BRAMA_URL` when set, otherwise the local Stado resolver's brama adapter
(`http://127.0.0.1:17601`); there is no provider fallback, and an
unreachable endpoint fails the run with exit `69`. `--plan <file>` skips
authoring entirely and validates plus emits an existing plan without any
model call.

## Validate

`pipeline/src/validate.mjs` runs five mechanical validators; the report is
one entry per validator with its failures, and all five must pass:

- **claims** — every `claim.evidence` occurs in its named source.
- **drift** — every documented command usage line and flag exists in the
  live binary's `--help`. Commands are allowlisted: only the product
  binary, only subcommand words plus `--help`/`--version`, nothing
  shell-interpreted.
- **terms** — a term used on three or more pages must be declared with a
  defining page.
- **structure** — the plan validates against the closed schema; there is no
  page kind outside it to choose.
- **coverage** — every page kind `brief.json` requires is present.

There is no quality judge and no scoring step: the writing standard is what
the author reads, the validators are what the build enforces.

## Emit

`pipeline/src/emit.mjs` turns a validated plan into a `DocPage` data module
— `docs.ts` in the `--out` directory — for the consuming site's
`DocumentationLayout`, along with the navigation grouping. Publication is
the consuming site's CI concern: deploy only on all-green.
