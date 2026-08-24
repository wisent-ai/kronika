# Runbook

Kronika failed — what does the sentence mean, and what do you check? Every
failure is one line on stderr, `kronika: <message>`, exit status `1`; sync
additionally reports per-document `failed` outcomes and exits `1` when any
document failed. Every sentence below exists verbatim in `src/` and the
marked ones were captured by running the CLI.

## Flags and commands

| Sentence | Meaning / fix |
|---|---|
| `Unknown command: <word>` † | first argument is not `check`, `write`, `sources`, `sync`, or help |
| `Unknown option: <flag>` † | flag not in [cli](cli.md); one parser serves all commands |
| `<flag> requires a value` † | value-taking flag at end of argv or followed by nothing |
| `<flag> must be a positive integer` † | numeric flags (`--max-*`, `--timeout-ms`) reject zero, negatives, non-integers |
| `check requires --base <ref>` † | `check` has no default base; pass the ref to audit from |

## Environment

| Sentence | Meaning / fix |
|---|---|
| `BRAMA_URL or MODEL_ROUTER_URL is required` † | `check`/`write`/`sync` need an endpoint; `sources` and help do not |
| `BRAMA_API_KEY or MODEL_ROUTER_TOKEN is required` † | bearer missing |
| `Brama agent ID and HMAC secret must be supplied together` † | exactly one of `WISENT_APP_AGENT_ID` / `WISENT_APP_AGENT_AUTH_SECRET` is set; set both or neither |
| `Brama URL is required`, `Brama API key is required` | library-only: `BramaClient` constructed with empty options (the CLI checks the environment first) |

See [configuration](configuration.md) for what each variable does.

## Selection refusals

From `src/sources.ts` and `src/writer.ts`; all before any network call:

| Sentence | Meaning / fix |
|---|---|
| `Source is outside the repository: <path>` † | explicit `--source` escapes `--repo`; selection is confined |
| `Source does not exist: <path>` † | explicit source missing |
| `Symbolic-link sources are not allowed: <path>` † | symlinks are never followed, even named explicitly |
| `Repository is not a directory: <path>` † | `--repo` points at a file |
| `Output is outside the repository: <path>` † | `--output` resolves outside `--repo`; refused by selector and writer both |
| `No safe UTF-8 source files were selected` † | `write` with an empty collection — everything was excluded, skipped, or empty; run `kronika sources` to see why |
| `Source byte limits must be positive` | library-only: `collectSources` called with non-positive budgets |

Skip *reasons* (in `skipped`, not errors): `generated, dependency, recording,
or private deployment directory` · `credential or generated lock file` ·
`private key or certificate material` · `larger than <n> bytes` ·
`total source limit <n> bytes reached` · `binary content` ·
`not valid UTF-8 text`. See [sources](sources.md).

## Git refusals

| Sentence | Meaning / fix |
|---|---|
| `Git commit cannot be resolved: <ref>` † | `--base`/`--head` is not a commit in this repository; check the ref and `--repo` |
| `Git diff cannot be read for <base>...<head>` | diff itself failed (shallow clone missing the merge base, corrupt repo) |
| `Git diff is <n> bytes, above --max-diff-bytes <m>; narrow or split the change rather than auditing a truncated diff` † | deliberate refusal — a truncated diff would audit a change that did not happen. Audit smaller ranges, restrict sync `sources`, or raise the budget knowingly |
| `Diff byte limit must be a positive integer` | library-only: `checkDocumentation` called with a non-positive `maxDiffBytes` (the CLI validates `--max-diff-bytes` first) |

## Transport and Brama answers

From `src/brama.ts`:

| Sentence | Meaning / fix |
|---|---|
| `fetch failed` † | Node's own sentence for a network-level failure (refused connection, DNS); Brama never answered. Check `BRAMA_URL` and reachability |
| `Brama request timed out after <n>ms` † | aborted at `--timeout-ms` (default `120000`) |
| `Brama returned HTTP <status>: <detail>` † | Brama answered an error; `<detail>` is the server's own `error`/`error.message` or the first 1000 bytes of the body — `empty response` when there was none. 401/403 are credential scope; 5xx is Brama-side |
| `Brama returned no documentation content` † | 2xx with an empty or unrecognizable completion body |

## Model output refusals

The model's answer is validated, never trusted. From `src/writer.ts`
(write/rewrite):

- `Brama returned documentation that is too short` † — under 20 characters
  after normalization
- `Brama returned invalid NUL content`

From `src/checker.ts` (audit verdicts):

- `Kronika returned invalid documentation-check JSON` † — the answer was not
  parseable JSON (one surrounding code fence is tolerated)
- `Kronika documentation check is not an object`
- `Kronika documentation check has no boolean passed field`
- `Kronika documentation check has no summary`
- `Kronika documentation check has no findings array`
- `Kronika documentation check contradicts its blocker findings` † —
  `passed` disagreed with the presence of blockers
- `Kronika finding <i> is not an object` / `has invalid severity` /
  `has invalid code` / `has invalid document` / `has invalid sourcePaths` /
  `has no message` / `has invalid requiredChange`

A retry is reasonable — these are usually one bad completion. Persistent
verdict failures on the same change mean the model selector is too weak or
the diff too large to reason over; try a stronger `--model`.

## Sync: fatal sentences

Manifest and state validation, fatal before any document is visited
(all †, captured):

- `Sync manifest is missing: <path>. Declare the maintained documents first.`
- `Sync manifest is not valid JSON: <path>`
- `Unsupported sync manifest schemaVersion in <path>`
- `Sync manifest declares no documents: <path>`
- `Sync manifest entry without an output path in <path>`
- `Sync manifest entry <output> declares no sources`
- `Sync state is not valid JSON: <path>. Fix or delete it to re-baseline.`
- `Unsupported sync state schemaVersion in <path>`

## Sync: per-document `failed` outcomes

Not thrown — reported per document, exit `1`, [baseline](concepts/baseline.md)
deliberately not advanced, next tick retries the same range:

| Detail | Meaning / fix |
|---|---|
| `the recorded baseline <sha12> cannot be diffed against HEAD: <git error>. Delete this entry from the state file to re-baseline.` † | history rewrite or corrupt entry; the remedy is in the sentence |
| `audit did not complete: <message>` † | the check failed — `<message>` is any transport/Git/verdict sentence above (captured offline: `audit did not complete: fetch failed`) |
| `audit found blockers but the rewrite did not complete: <message>` | the check worked, the write failed; findings are in the outcome, nothing was written |

## docs-cli (site pipeline)

The separate pipeline reports one JSON object and exits: `2` usage
(`node src/run.mjs <productRepo> --sources <file> [--plan <file>] [--out <dir>]`),
`69` model infrastructure down (`brama endpoint unreachable: <url>
(<detail>)` — network failure or the resolver adapter answering 502/503/504),
`1` any failing stage, `0` all green. An answering endpoint with another bad
status is `brama answered HTTP <status>: <body>`; a shapeless answer is
`brama answer had no choices[0].message.content`. See
[site-pipeline](site-pipeline.md).

† captured by running the built CLI against a toy repository; the remainder
quoted from `src/`.
