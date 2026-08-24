# Examples — kronika in practice

Executable examples as plain command sequences — `set -eu`, a usage
comment, env for values, nothing else. Every line is copy-paste runnable;
verification is itself a printed command or an exit status.

## Index

1. [`inspect-boundary.sh`](inspect-boundary.sh) — the evidence boundary
   without any model call: full manifest, a tight byte budget, explicit
   selection. Needs no Brama configuration at all; safe anywhere.
2. [`gate-a-change.sh`](gate-a-change.sh) — the CI documentation gate:
   `check --base origin/main --json`, exit status as the verdict. Blocked
   and passing runs, with real output, are in
   [walkthrough-check](../walkthrough-check.md).
3. [`sync-forever.sh`](sync-forever.sh) — one schedulable tick:
   `sync --dry-run` rehearsal, then `sync --commit --push`. Every action
   this can take, with real output, is in
   [walkthrough-sync-cycle](../walkthrough-sync-cycle.md).

## Grounding

Every command and flag here exists in `src/cli.ts` (see [cli](../cli.md));
the outputs these produce were captured against a toy repository in the two
walkthroughs. `inspect-boundary.sh` was executed as-is; the other two need
Brama credentials, and their model-independent behavior (offline refusals,
baseline/advance ticks, exit codes) was executed and captured with
placeholder credentials — see each walkthrough's "How this was captured".

## Environment

`gate-a-change.sh` and `sync-forever.sh` read the standard variables
([configuration](../configuration.md)): `BRAMA_URL`, `BRAMA_API_KEY`,
optionally `WISENT_APP_AGENT_ID` + `WISENT_APP_AGENT_AUTH_SECRET` (both or
neither), `KRONIKA_MODEL`. Credentials come from your environment, never
inline.
