# Library API

The npm package `@wisent-ai/kronika` exposes the same selection, generation,
audit, and sync contract as the CLI, as a dependency-free ES module for
Node.js 22+. The entry point is `dist/src/index.js`; everything below is a
named export of the package root.

## The completion boundary

All model access goes through one interface, so any client can substitute
for Brama in tests or embeddings:

```ts
interface CompletionClient {
  complete(request: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    model: string;
    maxTokens: number;
  }): Promise<{ content: string; model?: string }>;
}
```

- `BramaClient` — the production implementation. Constructor options:
  `url`, `apiKey`, optional `agentId`/`authSecret` (both or neither),
  `timeoutMs` (default `120000`), and `fetchImpl` to inject a fetch. The
  request and header contract is in [configuration](configuration.md).
- `signedHeaders(body, agentId, authSecret, timestampSeconds?)` — the HMAC
  header set (`x-agent-id`, `x-agent-timestamp`, `x-agent-signature`) for a
  given JSON body, exported so other callers can sign identically.

## Selection

- `collectSources(options: SourceOptions): SourceCollection` — builds the
  bounded source manifest; the rules are in [sources](sources.md).
  `SourceOptions` is `{ repo, sources?, output, maxInputBytes,
  maxFileBytes }`; the result is `{ documents, skipped, totalBytes }`.

## Generation

- `writeDocumentation(options: WriteDocumentationOptions, client):
  Promise<WriteDocumentationResult>` — one completion over the selected
  sources; with `apply: true` the output file is atomically replaced. The
  result carries `content`, `outputPath`, `applied`, `model?`, `sources`,
  and `skipped`.
- `buildDocumentationMessages(options, collection): ChatMessage[]` — the
  exact write prompt (system rules plus source payload), exported for
  inspection or reuse.

## Audit

- `checkDocumentation(options: CheckDocumentationOptions, client):
  Promise<CheckDocumentationResult>` — audits one `base`...`head` range;
  the semantics are in [cli](cli.md). `diffPaths` restricts the audited
  diff to given pathspecs — sync passes each document's declared sources
  here.
- `buildDocumentationCheckMessages(options, collection, change):
  ChatMessage[]` — the exact audit prompt.
- `parseDocumentationCheck(content)` — the strict verdict parser: JSON only
  (a surrounding code fence is tolerated), validated finding shape,
  kebab-case codes, and a `passed` value that must equal "no blockers".

## Sync

- `syncDocumentation(options: SyncOptions, client): Promise<SyncResult>` —
  one reconciliation tick over a manifest; the state machine is in
  [sync](sync.md). `SyncOptions` is `{ repo, manifestPath, statePath,
  dryRun, defaults }`; the result is `{ headSha, outcomes, stateWritten }`.
  Committing and pushing are CLI concerns, not library ones.
- `loadSyncManifest(path): SyncManifest` — reads and validates a manifest.
- `SYNC_MANIFEST_FILE`, `SYNC_STATE_FILE` — the default file names,
  `kronika.sync.json` and `kronika.sync-state.json`.

## Types

All contract types are exported: `ChatMessage`, `CompletionClient`,
`CompletionRequest`, `CompletionResult`, `SourceOptions`, `SourceDocument`,
`SkippedSource`, `SourceCollection`, `DocumentationFinding`,
`CheckDocumentationOptions`, `CheckDocumentationResult`,
`WriteDocumentationOptions`, `WriteDocumentationResult`, `SyncDefaults`,
`SyncDocument`, `SyncManifest`, `SyncOptions`, `SyncOutcome`, `SyncResult`,
and `SyncState`.

## Example

```ts
import { BramaClient, writeDocumentation } from "@wisent-ai/kronika";

const client = new BramaClient({
  url: process.env.BRAMA_URL!,
  apiKey: process.env.BRAMA_API_KEY!,
});

const result = await writeDocumentation({
  repo: "/path/to/project",
  output: "docs/architecture.md",
  sources: ["src", "README.md"],
  instruction: "Document components, request flow, and failure modes.",
  model: "any",
  maxInputBytes: 200_000,
  maxFileBytes: 64_000,
  maxTokens: 8_000,
  apply: false,
}, client);

process.stdout.write(result.content);
```
