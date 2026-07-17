import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectSources } from "../src/sources.js";
import type {
  CompletionClient,
  CompletionRequest,
  CompletionResult,
  WriteDocumentationOptions,
} from "../src/types.js";
import { writeDocumentation } from "../src/writer.js";

class RecordingClient implements CompletionClient {
  request?: CompletionRequest;

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.request = request;
    return {
      content: "```markdown\n# Canonical guide\n\nGenerated from verified source behavior.\n```",
      model: "task:documentation",
    };
  }
}

const createRepository = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "kronika-test-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "ignored"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Existing guide\n");
  writeFileSync(join(repo, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(join(repo, ".env"), "API_TOKEN=must-not-leak\n");
  writeFileSync(join(repo, "private.pem"), "PRIVATE KEY\n");
  writeFileSync(join(repo, "node_modules", "ignored", "index.js"), "secret dependency\n");
  writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  return repo;
};

test("collectSources keeps safe text and excludes credentials and generated trees", () => {
  const repo = createRepository();
  const collection = collectSources({
    repo,
    output: "README.md",
    sources: ["."],
    maxInputBytes: 100_000,
    maxFileBytes: 10_000,
  });

  assert.deepEqual(collection.documents.map((source) => source.path), [
    "README.md",
    "src/index.ts",
  ]);
  assert.ok(collection.skipped.some((source) => source.path === ".env"));
  assert.ok(collection.skipped.some((source) => source.path === "private.pem"));
  assert.ok(collection.skipped.some((source) => source.path === "binary.dat"));
  assert.ok(!collection.documents.some((source) => source.path.includes("node_modules")));
});

test("writeDocumentation grounds the prompt and atomically applies complete Markdown", async () => {
  const repo = createRepository();
  const client = new RecordingClient();
  const options: WriteDocumentationOptions = {
    repo,
    output: "docs/guide.md",
    sources: ["README.md", "src"],
    instruction: "Document the public answer contract.",
    model: "task:documentation",
    maxInputBytes: 100_000,
    maxFileBytes: 10_000,
    maxTokens: 4_000,
    temperature: 0.1,
    apply: true,
  };

  const result = await writeDocumentation(options, client);

  assert.equal(result.applied, true);
  assert.equal(result.model, "task:documentation");
  assert.equal(result.content, "# Canonical guide\n\nGenerated from verified source behavior.\n");
  assert.equal(readFileSync(join(repo, "docs", "guide.md"), "utf8"), result.content);
  assert.equal(client.request?.model, "task:documentation");
  const prompt = client.request?.messages.map((message) => message.content).join("\n") ?? "";
  assert.match(prompt, /Document the public answer contract/);
  assert.match(prompt, /BEGIN SOURCE: src\/index\.ts/);
  assert.match(prompt, /export const answer = 42/);
  assert.doesNotMatch(prompt, /must-not-leak/);
});

test("writeDocumentation rejects targets outside the repository", async () => {
  const repo = createRepository();
  const client = new RecordingClient();
  const options: WriteDocumentationOptions = {
    repo,
    output: "../outside.md",
    model: "any",
    maxInputBytes: 100_000,
    maxFileBytes: 10_000,
    maxTokens: 1_000,
    temperature: 0.1,
    apply: false,
  };

  await assert.rejects(
    writeDocumentation(options, client),
    /Output is outside the repository/,
  );
  assert.equal(client.request, undefined);
});
