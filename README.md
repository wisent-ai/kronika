<!-- wisent-banner:start -->
<p align="center">
  <img src="assets/readme-banner.webp" alt="kronika by Wisent" width="100%">
</p>
<!-- wisent-banner:end -->

<!-- wisent-readme-signals:start -->
[![Source](https://img.shields.io/badge/GitHub-Source-181717?logo=github)](https://github.com/wisent-ai/kronika) [![Issues](https://img.shields.io/badge/GitHub-Issues-181717?logo=github)](https://github.com/wisent-ai/kronika/issues) [![Wisent](https://img.shields.io/badge/Wisent-Website-0B0B0B)](https://wisent.com) [![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/qRjpkthq54) [![LinkedIn](https://img.shields.io/badge/LinkedIn-Follow-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/company/wisent-ai/) [![X](https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white)](https://x.com/wisentai) [![Enterprise](https://img.shields.io/badge/Enterprise-Book%20a%20call-0B0B0B?logo=calendly)](https://calendly.com/lbartoszcze)
<!-- wisent-readme-signals:end -->

# Kronika: Perfect Documentation Built Only from Repository Truth

Automated Documentation Creator and Updater.

You ship at the speed of light — but your documentation does not follow. With
Kronika, every commit impacts your documentation and you can make sure your docs
are full of intuitive, easy-to-follow and up-to-date examples. Review your older
documentation and make sure it is easy for your users and consistent with your
code.

Never have your docs drift away from your code.

It keeps repository selection, exclusions, request signing, output confinement,
and the final write under the operator's control. Source files are evidence, not
instructions to the model.

[Documentation](https://kronika.wisent.com/docs/) ·
[Quick start](https://kronika.wisent.com/docs/quick-start/) ·
[CLI reference](https://kronika.wisent.com/docs/cli/) ·
[Graphical importer](https://kronika.wisent.com/docs/gui/) ·
[Library API](https://kronika.wisent.com/docs/library/) ·
[Canonical repository](https://github.com/wisent-ai/kronika)

Version `0.2.0` is public development source. The package generates one local
document at a time and reconciles a manifest of documents per repository
(`kronika sync`); multi-repository orchestration, team review, retained
versions, organization search, and supported publishing are separate future
managed-service boundaries, not capabilities of this package.

## Problem and intended users

Repository documentation becomes stale because the evidence changes faster than
manual prose and because generated prose often loses the source boundary. A
useful writer must show what enters the prompt, exclude secret-prone files, bound
payloads, prevent repository content from becoming model instructions, preview
changes, and refuse writes outside the selected repository.

Kronika serves:

- **maintainers** drafting or regenerating README and technical documentation
  from a controlled source set;
- **reviewers** inspecting selected and skipped files before any model call;
- **documentation platform operators** integrating a local engine with a
  separately operated Brama route;
- **tool developers** embedding the same selection and generation contract
  through the TypeScript API.

## Product boundaries

### Included

- Git-aware source discovery with bounded recursive fallback outside a worktree;
- deterministic prioritization of existing output, README, `docs/`, manifests,
  configuration, schemas, and application source;
- exclusion of secret-prone files, private keys, dependency trees, build output,
  recordings, lock files, and private deployment state;
- source manifest, selected byte total, and skipped-file reasons;
- one signed OpenAI-compatible Brama completion request;
- prompt rules that treat repository content as untrusted evidence and prohibit
  invented commands, APIs, configuration, and status;
- preview-only output by default;
- explicit `--apply` with an atomic rename inside the selected repository;
- CLI, accessible local graphical importer, and a dependency-free runtime TypeScript library package.

### Explicit non-goals

- Kronika does not prove that generated prose is correct merely because selected
  source was supplied; a maintainer must review claims and omissions.
- It does not execute repository instructions, commands, build scripts, examples,
  or generated output.
- It does not allow an output or explicit source to escape the selected
  repository.
- The current package does not persist a stable source-span provenance graph,
  freshness history, approval workflow, organization taxonomy, or retained
  document versions.
- It does not schedule repositories, publish a site, configure SSO/RBAC, or
  provide an SLA.
- Private repositories, generated customer documents, prompts, responses,
  credentials, roadmaps, and production configuration must not be published as
  package fixtures or public issues.

### Supported environment and current capability

| Surface | Requirement | Current state |
|---|---|---|
| CLI and library | Node.js 22+ | Implemented |
| Adopt existing documentation | readable Markdown in `README.md`, `docs/`, or explicit `--docs` paths | Implemented; writes only `kronika.sync.json` |
| Graphical adoption | installed `kronika` CLI and a local browser | Implemented; loopback-only, writes only the same sync manifest as `init` |
| Local source inspection | readable repository | Implemented; no model call |
| Documentation preview | Brama URL and scoped bearer; optional request-signing identity | Implemented |
| Atomic apply | writable output within repository | Implemented with explicit flag |
| Exact Git-change documentation gate | Brama URL, scoped bearer, base/head refs | Implemented |
| Stable provenance/freshness store | — | Not implemented in `0.2.0` |
| Hosted scheduling/review/publishing | managed service | Not implemented by this package |

## Core use cases

### Initialize an existing documentation workspace

- **Actor:** a maintainer bringing a repository they already document.
- **Initial state:** existing Markdown under `README.md`, `docs/`, or explicit
  repository-relative `--docs` paths.
- **Outcome:** `kronika init` validates every document and evidence path, then
  atomically writes the established `kronika.sync.json` project manifest.
- **Boundary:** no documentation is generated or changed, no repository
  command is executed, and no Brama request occurs. An identical manifest is
  unchanged; a different one is preserved as a conflict unless `--replace` is
  explicit. Invalid or escaping paths leave no partial manifest.

### Initialize through the local graphical workspace

- **Actor:** a maintainer who prefers a browser form to repeatable CLI flags.
- **Initial state:** the installed CLI and an existing repository with Markdown.
- **Outcome:** `kronika gui --repo /path/to/project` prints an authenticated
  loopback URL. The form submits documents, evidence sources, manifest path,
  standing instruction, and explicit conflict replacement to the same
  `initializeDocumentationWorkspace` function as `kronika init`, then displays
  the exact persisted manifest readback.
- **Boundary:** the command does not open a browser, call Brama, generate or
  change documentation, execute repository commands, deploy, or run validation.

### Inspect the evidence boundary

- **Actor:** a maintainer or reviewer.
- **Initial state:** a local repository and optional explicit source paths.
- **Outcome:** `kronika sources` prints every selected file, total bytes, and
  skipped file with its reason.
- **Boundary:** no Brama call occurs and no repository file changes.

### Gate a code change against documentation

- **Actor:** CI or a reviewer with scoped Brama access.
- **Initial state:** one resolvable base commit and head commit in the selected
  repository.
- **Outcome:** `kronika check` audits the bounded Git diff and current
  repository sources, emits a structured verdict, and exits non-zero for
  concrete documentation blockers.
- **Boundary:** internal refactors do not require documentation churn; only
  omitted or contradictory public behavior, interfaces, configuration,
  security boundaries, and operational contracts block.

### Preview a complete document

- **Actor:** a maintainer with scoped Brama access.
- **Initial state:** selected sources, output path, instruction, model selector,
  and payload bounds are explicit.
- **Outcome:** Kronika signs one completion request and writes the candidate
  Markdown to stdout.
- **Boundary:** preview does not modify the repository; the result remains
  model-generated and requires human review against source.

### Apply a reviewed replacement

- **Actor:** a maintainer authorized to edit the target repository.
- **Initial state:** the same generation request includes `--apply` and its
  output path stays inside the repository.
- **Outcome:** Kronika atomically replaces the requested document.
- **Boundary:** applying does not run formatting, tests, deployment, publishing,
  or approval workflow.

## How Kronika works

```text
repository
   │
   ├─ git-aware discovery / explicit sources
   ├─ secret and artifact exclusions
   └─ byte and path bounds
             │
             ▼
 selected-source manifest + documentation instruction or exact Git diff
             │ scoped bearer + exact JSON body; optional HMAC
             ▼
           Brama
             │
             ├─ complete Markdown candidate
             │    ├─ stdout preview (default)
             │    └─ atomic in-repository replacement (--apply)
             └─ structured documentation verdict (check)
```

Kronika owns source selection, prompt construction, optional request signing,
output validation, and local replacement. Brama owns client authorization,
model selection, and inference. Git and the repository remain authoritative
for source and review history.

## Quick start

This safe path builds the package, adopts its existing Markdown into Kronika's
project manifest, and inspects the evidence boundary. It makes no model request
and does not generate or rewrite documentation.

### Prerequisites

- Git;
- Node.js 22 or newer;
- npm.

```bash
git clone https://github.com/wisent-ai/kronika.git
cd kronika
npm install
npm run build
node dist/src/cli.js init --repo .
node dist/src/cli.js sources --repo . --source README.md --source src
```

Expected result: `init` reports every imported document and writes only
`kronika.sync.json`; `sources` prints the selected manifest, byte total, and
skipped files with reasons. Only configure Brama after reviewing that boundary.

For local command installation:

```bash
npm link
kronika sources --repo /path/to/project
```

To use the graphical importer instead, keep this foreground command running and
open the exact session URL it prints:

```bash
kronika gui --repo /path/to/project
```

The server binds `127.0.0.1` on an operating-system-assigned port (or pass
`--port 4173`), requires its per-session token and exact origin/host for
mutation, and never opens a browser itself.

## Primary interfaces and the library API

Every verb — adopting existing documents, collecting sources, checking a
change, writing a document, syncing a whole set, the loopback workspace
and the first-use journey — and the library API are in
[docs/interfaces.md](docs/interfaces.md).

## Site pipeline (formerly `docs-cli`)

Turning a product repository into its documentation site, and the gate
that holds the result to its evidence, is in
[docs/site-pipeline.md](docs/site-pipeline.md).

## Operational model

- **Configuration:** CLI/API arguments plus scoped Brama URL, bearer, optional
  request-signing identity and secret, and model selector.
- **State:** no hosted database; output and Git history remain in the selected
  repository.
- **Credentials:** bearer and optional HMAC material are runtime secrets and
  must never enter source, output, logs, or public issues.
- **Observability:** selected/skipped source manifest, byte totals, resolved
  base/head SHAs, changed paths, documentation findings, preview,
  machine-readable result, Brama errors, and Git diff after apply.
- **Recovery:** preview by default; an applied file is atomically replaced and
  should be recovered through repository version control.
- **Cost:** local inspection is free of model use; each write or check uses
  configured Brama inference. Managed repository scheduling, storage, review,
  and publishing remain responsibilities of the calling pipeline.

## Project status and support

- **Maturity:** public development package, version `0.2.0`.
- **Release surface:** compiled `dist`, README, and licence; no runtime npm
  dependencies.
- **Local contract:** source selection, bounded Brama generation, exact
  Git-change documentation checks, preview, and explicit atomic apply.
- **Managed contract:** scheduling, retained versions, organization
  search/access controls, publishing, private deployment, and SLA are provided
  by the calling pipeline rather than this package.
- **Issues:** [`wisent-ai/kronika`](https://github.com/wisent-ai/kronika/issues).
- **Security and privacy:** use private GitHub Security Advisories; never attach
  private source, generated customer documents, prompts, responses, credentials,
  roadmaps, taxonomy, or production configuration to a public issue.
- **License:** Apache License 2.0; see [`LICENSE`](LICENSE).

