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
| Surface detection | [`pipeline/src/stages/detect.mjs`](../pipeline/src/stages/detect.mjs) | `brief.json` — computed from the product repo, not decided by anyone |
| Plan authoring | model via Brama | `plan.json` conforming to [`pipeline/schemas/plan.schema.json`](../pipeline/schemas/plan.schema.json) |
| Validation | [`pipeline/src/stages/validate.mjs`](../pipeline/src/stages/validate.mjs) | pass/fail per validator, machine-readable report |
| Writing standard | `pipeline/src/WRITING-STANDARD.md`, read by the authoring stage and injected into its prompt; this repository no longer carries the file, so authoring stops naming that path until it is restored | injected into the authoring prompt |
| Emission | [`pipeline/src/stages/emit.mjs`](../pipeline/src/stages/emit.mjs) | `DocPage` data module for `DocumentationLayout` |
| Publication | consumer site CI | deploy only on all-green |

Five validators gate the plan, each one a defect the operator caught by hand:
**claims** (every `claim.evidence` occurs in its named source),
**drift** (every documented command usage line and flag exists in the live
binary's `--help`), **terms** (Brama judges recurring undeclared words against
the complete page prose; product concepts need a defining page),
**structure** (closed page kinds), and **coverage** (every completion-gate kind that
`brief.json` says applies is present, and every command the binary's `--help`
advertises has a `cli-reference` page whose slug is `cli/<command>` or below
it — a command with no page of its own is refused before anything emits).
Detection requires a readable `Commands:` section with command names, rather
than treating an unfamiliar help layout as an empty CLI. CRLF output and a
command section at the end of the response are accepted. An unreadable section
retains the complete help text in the named CLI failure. Coverage refuses a
declared CLI without a successful, nonempty observed command inventory,
including briefs from older detection runs that silently omitted commands.
Coverage then reads the binary's current `--help` again and uses the same
command parser as detection. A command added after the brief was generated
still needs its own page; an unavailable binary, failed help command or
unreadable inventory fails coverage rather than trusting stale evidence.
Coverage follows every advertised command's own `--help` recursively. Nested
commands need matching paths such as `cli/fleet/create`, not just `cli/fleet`.
A leaf must expose a `Usage:` section; failed or unreadable child help and
repeated ancestor inventories fail with the complete command path and cause.
Missing `plan.pages` or detection's `brief.requiredKinds` is an explicit
coverage failure, never an assumed empty collection.
Emission refuses, naming the page slug, section and block, a block that does
not carry its type's content (`text` for a paragraph, `items` for bullets and
steps, `code`, `table`, `callout`), a block type it cannot render, and a second
table or callout in one section, which a `DocPage` section holds only once. A
page with no `group` is listed in the sidebar under the plan's `product`.
Drift compares complete long-option tokens, not substrings: documenting
`--output` does not pass merely because help lists `--output-format`.
Drift resolves leading command words through each parent's observed command
inventory. Once it reaches a leaf, following positional values are operands,
not additional help subcommands. An unadvertised command word at a parent
reports that parent's command path and the unresolved word.
Each product invocation on a separate line is checked against its own command
help, including a command after a comment or another command. Backslash-newline
continuations belong to the same invocation. Flags on one invocation are not
validated against another invocation's help.

The reusable real-interface journey is `node tests/coverage/cli.mjs`. Declare
`KRONIKA_TEST_SOURCE_REVISION`, `KRONIKA_TEST_PRODUCT_REPO`, `KRONIKA_TEST_PLAN`,
`KRONIKA_TEST_BRIEF`, `KRONIKA_TEST_REQUIRED_COMMAND_PAGE`,
`KRONIKA_TEST_SUCCESS_EXIT` and `KRONIKA_TEST_FAILURE_EXIT`. Use an authored
plan and detected brief for a real binary; any terms adjudication uses the
configured Brama service. The baseline must pass all validators. The journey
then removes a required command page and separately names an absent binary,
requiring actual coverage refusals. Reports retain source revisions, binary
and fixture digests, commands, exit statuses and complete validator output in
`.build/coverage/<run>/report.json`; only run-owned fixture copies are removed.
Cleanup attempts both owned removals even when one fails. Each failed removal
retains its path and cause beside the original result, marks the journey failed,
and is reported only after the final evidence write is attempted.

Commands: `node pipeline/src/stages/detect.mjs` · `node pipeline/src/stages/validate.mjs` · `node pipeline/src/stages/emit.mjs`
(or the `kronika-site` binary). Every entry point — `kronika-site` and each stage under `pipeline/src` — answers `--help`, prints its report as JSON or with `--text` as one `path: value` line per field of the same report, and exits 2 on an unknown option or a missing argument; 1 means a stage failed and 69 that Brama is down. Model access resolves through Brama only —
`BRAMA_URL`, then the address Stado's service directory published for this
machine in `~/.stado/forwards/brama.local` (`stado service directory
publish` writes it); with neither, authoring stops with `not_configured`
naming both. No address is built in, and there is no
provider fallback. There is no prose quality score. The terms validator asks
Brama's decision alias `decision-model` on `POST /v1/decisions` one typed
choice per recurring undeclared word, `concept` or `ordinary`, with the plan's
pages as the state, so a word is demanded as a term only when Brama chose
`concept` for it; `--model` selects the authoring model and does not apply to
this decision. An unavailable answer, an unanswered word or an option Brama
was not given fails that validator by name. Other
validators check evidence, structure and coverage mechanically. Publication
follows the consuming site's CI.

The selected address must be an absolute HTTP(S) base URL without embedded
credentials, a query or a fragment. A present but empty or invalid `BRAMA_URL`
is refused by name; it never selects the Stado marker instead. The marker is
read only when `BRAMA_URL` is unset and undergoes the same URL validation.
Address refusals identify the declaration without echoing its contents.
Inference redirects are returned as the selected route's HTTP refusal, never
followed with the prompts. Failure while reading a response names its HTTP
status and transport cause; invalid JSON or missing assistant content retains
the endpoint, status and complete received body.

An exception inside a validator becomes a failure of that named validator with
its actual cause. Invalid evidence expressions, unreadable source files and
malformed plan fields do not abort the remaining validators' reports. No failed
validator is treated as approval; emission still requires every validator to pass.

The authoring request carries the selected model and the complete messages, and
asks for the plan as the arguments of one required function call whose
parameters are a strict JSON Schema, so the plan is the model's answer itself
and never JSON picked out of prose. That answer schema is derived from
`plan.schema.json`: a field the plan leaves optional is asked for as nullable
and left out of the plan when null, and `sources` is asked for as a list of
`{ key, value }` entries that becomes the named registry again. A key named
twice, a value of the wrong shape, an answer without exactly that one call, or
arguments that are not one JSON object stops authoring with `author_failed` and
that cause. A gateway-unavailability status from Brama is reported as
`infra_down` (exit 69) with Brama's complete body. The plan read
back is then held to the whole plan schema, its length and count bounds
included.
Authoring reads its evidence from the brief: the live binary's `--help` and
every declared file detection found readable. Kronika does not choose a
sampling temperature; the Brama route owns generation settings. A failed Brama
response reports its HTTP status and complete error body, without a
fixed-size diagnostic preview.
Source commands retain complete stdout, stderr and multiline failure details;
there is no pipeline-selected output byte ceiling. URL evidence failures name
the URL, HTTP status and complete response body, or the transport cause. A
failure is not empty source evidence and cannot support a publishing claim.
If the CLI help probe fails during authoring, the stage stops before contacting
Brama and names the binary, exit result, process error and both captured streams.
Partial stdout from a failed command is not accepted as source evidence.

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
