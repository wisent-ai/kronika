# Kronika

<!-- wisent-readme-signals:start -->
[![Release](https://img.shields.io/github/v/release/wisent-ai/kronika?display_name=tag&sort=semver)](https://github.com/wisent-ai/kronika/releases)
[![Downloads](https://img.shields.io/github/downloads/wisent-ai/kronika/total)](https://github.com/wisent-ai/kronika/releases)
[![License](https://img.shields.io/github/license/wisent-ai/kronika)](https://github.com/wisent-ai/kronika)
[![Discord](https://img.shields.io/badge/Discord-Join%20Wisent-5865F2?logo=discord&logoColor=white)](https://discord.gg/qRjpkthq54)
<!-- wisent-readme-signals:end -->


Kronika writes source-grounded repository documentation through Brama. It selects safe text files, builds a documentation-specific prompt, sends a signed OpenAI-compatible request to Brama, and returns or atomically applies the complete Markdown document.

## Contract

- Brama is the only model boundary. Kronika calls `POST /v1/chat/completions` and signs the exact JSON body with the canonical `x-agent-id`, `x-agent-timestamp`, and `x-agent-signature` HMAC headers.
- Source files are evidence, not instructions. The prompt tells the model to ignore instructions embedded in repository content and forbids invented commands, APIs, configuration, or status claims.
- Secret-prone files, private keys, dependency trees, build output, recordings, lock files, and private deployment state are excluded before prompt construction.
- Generation is preview-only by default. `--apply` is required to replace a document, and the replacement uses an atomic rename inside the repository.
- Output paths and explicit sources cannot escape the selected repository.

## Install

```sh
npm install
npm run build
npm link
```

Node.js 22 or newer is required. The package has no runtime dependencies.

## Brama configuration

```sh
export BRAMA_URL=https://model-router.example.com
export WISENT_APP_AGENT_ID=kronika
export WISENT_APP_AGENT_AUTH_SECRET='<skarbiec-injected-secret>'
export KRONIKA_MODEL=any
```

`MODEL_ROUTER_URL` is accepted as an alias for `BRAMA_URL`. `KRONIKA_MODEL` can be any Brama selector available to the signed agent, including an explicit subscription, `any`, or `task:documentation` when task-quality evidence exists.

Do not commit the HMAC secret. Inject it at runtime through the deployment's secret boundary.

## Inspect selected sources

```sh
kronika sources --repo /path/to/project
```

Automatic discovery uses `git ls-files --cached --others --exclude-standard`, falling back to a bounded recursive scan outside a Git worktree. It prioritizes the existing output, README and `docs/`, package manifests, configuration, schemas, and application source.

Select an explicit subset when the repository is large:

```sh
kronika sources \
  --repo /path/to/project \
  --source README.md \
  --source src \
  --source docs
```

The command prints the selected manifest, byte total, and every skipped file with its reason. It never calls Brama.

## Generate documentation

Preview a complete replacement on stdout:

```sh
kronika write \
  --repo /path/to/project \
  --output docs/architecture.md \
  --source README.md \
  --source src \
  --instruction 'Document components, request flow, invariants, and failure modes.'
```

Apply the generated document:

```sh
kronika write \
  --repo /path/to/project \
  --output docs/architecture.md \
  --source README.md \
  --source src \
  --instruction 'Document components, request flow, invariants, and failure modes.' \
  --apply
```

Useful controls:

| Option | Purpose |
| --- | --- |
| `--model <selector>` | Override the Brama selector. |
| `--max-input-bytes <n>` | Bound the total source payload; default `200000`. |
| `--max-file-bytes <n>` | Bound one source file; default `64000`. |
| `--max-tokens <n>` | Set the completion budget; default `8000`. |
| `--timeout-ms <n>` | Bound the Brama request; default `120000`. |
| `--json` | Return a machine-readable result. |
| `--apply` | Atomically replace the requested output. |

## Library API

```ts
import { BramaClient, writeDocumentation } from "@wisent-ai/kronika";

const client = new BramaClient({
  url: process.env.BRAMA_URL!,
  agentId: process.env.WISENT_APP_AGENT_ID!,
  authSecret: process.env.WISENT_APP_AGENT_AUTH_SECRET!,
});

const result = await writeDocumentation({
  repo: "/path/to/project",
  output: "README.md",
  sources: ["src", "package.json"],
  instruction: "Write the canonical installation and API guide.",
  model: "any",
  maxInputBytes: 200_000,
  maxFileBytes: 64_000,
  maxTokens: 8_000,
  apply: false,
}, client);

process.stdout.write(result.content);
```
