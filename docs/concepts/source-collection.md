# Source collection

What exactly does the model get to read? A source collection: the explicit,
bounded, inspectable set of repository files that one `write` or `check`
call puts in front of Brama. Nothing reaches a prompt that is not in the
collection, and everything that was considered but excluded is named with
its reason.

## What it is

`collectSources` (`src/sources.ts`) returns one `SourceCollection`:

| Field | Type | Meaning |
|---|---|---|
| `documents` | `SourceDocument[]` | selected files: `path` (repository-relative, `/`-separated), `content`, `bytes` |
| `skipped` | `SkippedSource[]` | excluded files: `path` and a human-readable `reason` |
| `totalBytes` | number | sum of selected `bytes`, always ≤ `maxInputBytes` |

`kronika sources` prints exactly this object (paths and byte counts, not
content) without calling Brama — the boundary is inspectable before it is
used. Captured against a toy repository:

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
    { "path": "credentials.json", "reason": "credential or generated lock file" },
    { "path": "notes.txt", "reason": "binary content" }
  ]
}
```

## Lifecycle

1. **Candidates.** Without `--source`: `git ls-files --cached --others
   --exclude-standard` (tracked plus untracked-not-ignored; a global Git
   ignore file applies here too), or a bounded recursive walk when the path
   is not a Git worktree. With `--source` (repeatable): only the named files
   and directories.
2. **Confinement.** Candidates outside the repository root are dropped; an
   *explicit* source outside it is an error, as is a symbolic link or a
   missing path.
3. **Exclusion.** Secret-prone and generated paths are skipped by name:
   excluded directories are never entered; credential/lock filenames and key
   extensions are skipped with a reason.
4. **Text filter.** Automatic discovery keeps only allowlisted text
   extensions plus `Dockerfile`, `Makefile`, `Procfile`, `README`,
   `README.*`. Explicit selections bypass this filter only.
5. **Ordering.** Candidates are ranked (output document first, then
   `README.md`/`docs/`, then project manifests, then config/schema paths,
   then `src/`/`app/`, then the rest, tests last), ties alphabetical.
6. **Budgets.** A file over `maxFileBytes` is skipped (`larger than <n>
   bytes`); once `maxInputBytes` would be exceeded, the rest are skipped
   (`total source limit <n> bytes reached`) — ordering decides what the
   budget is spent on.
7. **Content checks.** NUL content → `binary content`; non-UTF-8 → `not
   valid UTF-8 text`; empty-after-trim files are silently dropped.

The complete rule tables — every excluded directory, filename, extension,
and the exact priority ranks — are in [sources](../sources.md).

## Invariants

- The prompt payload is exactly `documents`, framed per file as
  `===== BEGIN SOURCE: <path> =====` … `===== END SOURCE …` (write) or
  `BEGIN REPOSITORY FILE` (check) — the model is told where each file
  starts and ends.
- Every considered-but-excluded file is either in `skipped` with a reason or
  outside the candidate set entirely (non-text extensions under automatic
  discovery, empty files).
- Selection never follows a symbolic link and never leaves the repository.
- The same collector serves `sources`, `write`, `check`, and every sync
  audit and rewrite — there is one boundary, not four.

## Refusals

Exact sentences from `src/sources.ts`:

- `Source is outside the repository: <path>`
- `Source does not exist: <path>`
- `Symbolic-link sources are not allowed: <path>`
- `Repository is not a directory: <path>`
- `Output is outside the repository: <path>`
- `Source byte limits must be positive` (library callers only; the CLI
  validates its numeric flags first)

`write` additionally refuses an empty collection:
`No safe UTF-8 source files were selected` (`src/writer.ts`).

## Not to be confused with

- **The [sync manifest](manifest.md)** — declares *which* documents are
  maintained from which evidence paths; the collection is what one call
  actually read within those paths and budgets.
- **[Drift](drift.md)** — computed from Git history over declared pathspecs,
  not from the collection; a file can be drift-relevant yet skipped from the
  payload by a budget.
