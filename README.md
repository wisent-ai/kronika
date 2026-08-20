# docs-cli

Turn a product repository into its documentation site, automatically, then
hold every page to mechanical checks before anything publishes. The
documentation equivalent of [landing-cli](https://github.com/wisent-ai/landing-cli):
a model authors a **typed content plan** — never markup — and everything
around the model is deterministic and verifiable.

Built after 2026-08-19, when hand-authored product docs were removed by the
operator: model-written prose invented structure (a "Boundaries" convention no
reference uses), used undefined terms ("fleet"), and attached evidence
post-hoc. This pipeline makes each of those defects a build failure instead of
a review finding.

## The pipeline

| Stage | Owner | Artifact |
|---|---|---|
| Surface detection | `src/detect.mjs` | `brief.json` — computed from the product repo, not decided by anyone |
| Plan authoring | model via Brama | `plan.json` conforming to `schemas/plan.schema.json` |
| Validation | `src/validate.mjs` | pass/fail per validator, machine-readable report |
| Rubric judgment | second model via Brama | quality score above the mechanical floor |
| Emission | `src/emit.mjs` | `DocPage` data module for `DocumentationLayout` |
| Publication | consumer site CI | deploy only on all-green |

## Surface detection (`brief.json`)

The page set is a formula over what the repository actually exposes, per the
completion gate in
[product-guidelines/documentation-guidelines.md](https://github.com/wisent-ai/product-guidelines/blob/main/documentation-guidelines.md):

- a CLI binary → command reference (from `--help` walks) and quick start;
- an HTTP route table → machine API reference;
- a configuration document/schema → configuration reference;
- `CHANGELOG.md` → changelog, and migration pages iff breaking entries exist;
- declared limits/quotas → limits;
- always: overview, support tail.

`detect` reads a small `docs-sources.json` declaration in the product repo
naming where these live (binary name, changelog path, route file, config doc)
and probes each one; it never invents a surface.

## The plan is the only thing a model writes

`schemas/plan.schema.json`: pages have closed `kind`s (no invented page
types), every content block carries a `claim` — a named source plus a
verbatim-or-regex `evidence` string that must occur in that source — and the
plan declares every recurring `term` with the page that defines it. A block
without a resolvable claim cannot exist in a valid plan.

## Validators (each one is a defect the operator caught by hand on 2026-08-19)

1. **claims** — every `claim.evidence` occurs in its named source (file read,
   command run, or fetched URL). Catches fabricated facts.
2. **drift** — every documented command usage line and flag exists in the live
   binary's `--help`. Catches invented flags.
3. **terms** — every term used on ≥3 pages appears in `plan.terms` with a
   defining page that exists. Catches "fleet was never defined".
4. **structure** — the plan validates against the schema (closed page kinds,
   no Boundaries kind exists to choose). Catches invented conventions.
5. **coverage** — every completion-gate kind that `brief.json` says applies is
   present. Catches "almost complete".

## Model access

Author and judge call one OpenAI-compatible endpoint resolved in order:
`BRAMA_URL` env → the local Stado resolver's brama adapter. There is no
provider fallback: no Brama, no authoring — the pipeline fails with the named
infrastructure error rather than calling a provider directly.

## Honest current state

The judge rubric is a stub until a docs rubric exists in Probierz; the
mechanical validators carry the gate today. Emission targets
`DocumentationLayout` (`@wisent-ai/components` ≥0.4.0) data modules.
