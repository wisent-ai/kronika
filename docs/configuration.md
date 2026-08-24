# Configuration

Kronika has no configuration file of its own. Behavior is set by CLI flags
(defaults in [cli](cli.md)), Brama access by environment variables, and the
sync loop by the per-repository manifest described in [sync](sync.md).

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `BRAMA_URL` | yes, for `check`/`write`/`sync` | Brama origin; `MODEL_ROUTER_URL` is an accepted alias |
| `BRAMA_API_KEY` | yes, for `check`/`write`/`sync` | scoped bearer token; `MODEL_ROUTER_TOKEN` is an accepted alias |
| `WISENT_APP_AGENT_ID` | optional | request-signing agent identity |
| `WISENT_APP_AGENT_AUTH_SECRET` | optional | request-signing HMAC secret |
| `KRONIKA_MODEL` | optional | default `--model` selector; `any` when unset |

`kronika sources` and `kronika --help` read none of these. A missing URL or
bearer is an immediate error (`BRAMA_URL or MODEL_ROUTER_URL is required`).
The agent ID and HMAC secret must be supplied together or not at all — the
client refuses one without the other. `.env.example` at the repository root
lists exactly these variables; the bearer and signing secret are runtime
secrets and must never be committed.

## The Brama request

Every model interaction is one POST to `<BRAMA_URL>/v1/chat/completions`
(trailing slashes on the URL are stripped) with an OpenAI-compatible body:
`model`, `messages`, `max_tokens`. Headers:

- `authorization: Bearer <BRAMA_API_KEY>` — always.
- When the signing pair is set: `x-agent-id`, `x-agent-timestamp` (Unix
  seconds), and `x-agent-signature` — an HMAC-SHA256 over
  `<agentId>:<timestamp>:<sha256-hex-of-body>` keyed with the secret, so the
  signature commits to the exact JSON body.

The request is aborted after `--timeout-ms` (default `120000`) with the
error `Brama request timed out after <n>ms`. A non-2xx response surfaces as
`Brama returned HTTP <status>` with the server's error detail. The response
may carry `content` directly or the OpenAI `choices[0].message.content`
shape (string or text parts); an empty completion is the error
`Brama returned no documentation content`. Every transport sentence, with
meaning and fix, is in the
[runbook](runbook.md#transport-and-brama-answers).

## Model selection

`--model` (default `KRONIKA_MODEL`, then `any`) is passed through to Brama
as the `model` field. Kronika does not resolve providers or models itself —
Brama owns client authorization, model selection, and inference. In the
sync loop, a per-document `model` in the manifest overrides the flag.

## Budgets

All budgets are plain flags with per-document overrides in the sync
manifest: `--max-input-bytes` and `--max-file-bytes` bound the source
payload ([sources](sources.md)), `--max-tokens` bounds the completion, and
`--max-diff-bytes` bounds the audited Git diff — an oversized diff is
refused, never truncated. Defaults: `200000`, `64000`, `8000`, `200000`.

## The site pipeline's endpoint

The separate `docs-cli` pipeline resolves its model endpoint independently:
`BRAMA_URL` when set, otherwise the local Stado resolver's brama adapter at
`http://127.0.0.1:17601`. There is no provider fallback; when the endpoint
is down the pipeline exits with code `69`. See
[site-pipeline](site-pipeline.md).
