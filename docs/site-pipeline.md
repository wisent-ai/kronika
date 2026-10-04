<!-- Moved out of README.md, which had passed the three-hundred-line limit
     every file in this workshop lives under. Nothing here was rewritten. -->

## Site pipeline (formerly `docs-cli`)

Beyond single-document writing, Kronika ships a documentation-site pipeline:
turn a product repository into its documentation site automatically, then hold
every page to mechanical checks before anything publishes. It is the
documentation equivalent of [landing-cli](https://github.com/wisent-ai/landing-cli):
a model authors a **typed content plan** — never markup — and everything around
the model is deterministic and verifiable.

| Stage | Owner | Artifact |
|---|---|---|
| Surface detection | [`pipeline/src/detect.mjs`](pipeline/src/detect.mjs) | `brief.json` — computed from the product repo, not decided by anyone |
| Plan authoring | model via Brama | `plan.json` conforming to [`pipeline/schemas/plan.schema.json`](pipeline/schemas/plan.schema.json) |
| Validation | [`pipeline/src/validate.mjs`](pipeline/src/validate.mjs) | pass/fail per validator, machine-readable report |
| Writing standard | [`pipeline/WRITING-STANDARD.md`](pipeline/WRITING-STANDARD.md), distilled from the 50-reference evidence set and the restored human corpus | injected into the authoring prompt |
| Emission | [`pipeline/src/emit.mjs`](pipeline/src/emit.mjs) | `DocPage` data module for `DocumentationLayout` |
| Publication | consumer site CI | deploy only on all-green |

Five validators gate the plan, each one a defect the operator caught by hand:
**claims** (every `claim.evidence` occurs in its named source),
**drift** (every documented command usage line and flag exists in the live
binary's `--help`), **terms** (every recurring term has a defining page — no
"fleet was never defined"), **structure** (closed page kinds; no Boundaries
kind exists to choose), and **coverage** (every completion-gate kind that
`brief.json` says applies is present, and every command the binary's `--help`
advertises has a `cli-reference` page whose slug is `cli/<command>` or below
it — a command with no page of its own is refused before anything emits).

Commands: `npm run docs:detect` · `npm run docs:validate` · `npm run docs:emit`
(or the `kronika-site` binary). Every entry point — `kronika-site` and each stage under `pipeline/src` — answers `--help`, prints its report as JSON or with `--text` as one `path: value` line per field of the same report, and exits 2 on an unknown option or a missing argument; 1 means a stage failed and 69 that Brama is down. Model access resolves through Brama only —
`BRAMA_URL`, then the address Stado's service directory published for this
machine in `~/.stado/forwards/brama.local` (`stado service directory
publish` writes it); with neither, authoring stops with `not_configured`
naming both. No address is built in, and there is no
provider fallback. There is no quality judge and no scoring step: the
writing standard is what the author reads, the mechanical validators are
what the build enforces, and publication follows the consuming site's CI.

The writing standard itself was written by reading exactly its two named
sources — the 50-reference evidence set in Spis and our own previous
documentation (the restored February corpus). When either source changes,
the standard changes with it.

The writing standard for everything this pipeline produces is the operator's
restored human-written corpus (the February 2026 Wisent documentation, now
live at `ster.wisent.com/docs`) together with the 50-reference evidence set in
`product-guidelines/documentation-site-examples/`: same page kinds, same
anatomy, same sourcing discipline. The validators below enforce that bar
mechanically because the author here is a model.
