# Source selection

Every model call starts from an explicit, inspectable source manifest. The
selection subsystem (`src/sources.ts`, exported as `collectSources`) owns
discovery, exclusion, ordering, and byte budgets; `kronika sources` prints
its result without calling Brama.

## Discovery

Without `--source`, discovery is automatic:
`git ls-files --cached --others --exclude-standard` lists tracked plus
untracked-but-not-ignored files; when the path is not a Git worktree, a
bounded recursive walk is used instead. The walk never follows symbolic
links and never enters excluded directories.

With `--source` (repeatable), only the named files and directories are
candidates. An explicit source must exist, must lie inside the repository,
and must not be a symbolic link — each violation is an error. Directories
are walked with the same exclusion rules.

## Exclusions

Exclusions apply to every candidate, automatic or explicit, and each
excluded file appears in `skipped` with its reason:

- **Directories, never entered:** `.git`, `.next`, `.turbo`, `.vercel`,
  `.venv`, `build`, `coverage`, `dist`, `node_modules`, `recordings`,
  `target`, `vendor` — reported as "generated, dependency, recording, or
  private deployment directory".
- **Credential and lock files:** `.env` and any `.env.*`, `.netrc`,
  `.npmrc`, `auth.json`, `credentials.json`, `secrets.json`, `id_rsa`,
  `id_dsa`, `id_ed25519`, and lock files (`package-lock.json`, `yarn.lock`,
  `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`).
- **Key material:** any `.key`, `.pem`, `.p12`, `.pfx` file.

Automatic discovery additionally keeps only recognizably textual files: a
fixed extension allowlist (`.ts`, `.js`, `.py`, `.rs`, `.go`, `.md`,
`.json`, `.yaml`, `.toml`, `.sql`, `.proto`, and the rest of the common
source and config extensions) plus `Dockerfile`, `Makefile`, `Procfile`,
`README`, and `README.*`. Explicit selections skip this filter but still
pass the exclusion, size, binary, and encoding checks below.

## Ordering

Candidates are ranked so the budget is spent on the most relevant evidence
first, ties broken alphabetically:

| Rank | Paths |
|---|---|
| 0 | the output document itself |
| 1 | `README.md`, anything under `docs/` |
| 2 | `package.json`, `pyproject.toml`, `cargo.toml`, `go.mod` |
| 3 | paths containing `config` or `schema` |
| 4 | anything under `src/` or `app/` |
| 5 | everything else |
| 6 | paths containing `test` |

## Budgets and content checks

Two byte budgets bound the payload, both required to be positive:

- `--max-file-bytes` (default `64000`): a larger file is skipped with reason
  `larger than <n> bytes`.
- `--max-input-bytes` (default `200000`): once the running total would be
  exceeded, further files are skipped with reason
  `total source limit <n> bytes reached` — which is why ordering matters.

Each surviving file is then read and checked: content containing a NUL byte
is skipped as `binary content`; content that does not decode as strict UTF-8
is skipped as `not valid UTF-8 text`; files that are empty after trimming
are silently dropped. What remains is the manifest — path, content, and
byte count per file, plus the total — that [write and check](cli.md) put in
front of the model.

## Confinement

The selection and the output are confined to one repository. A candidate
outside the repository root is dropped; an explicit source outside it is an
error; an `--output` that resolves outside the repository is an error in
both the selector and the writer. The writer's atomic replacement
([cli](cli.md)) operates only on that confined path.
