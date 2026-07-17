import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { BramaClient, signedHeaders } from "../src/brama.js";

const listen = async (server: Server): Promise<number> => {
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  return port;
};

test("signedHeaders matches Brama's canonical HMAC contract", () => {
  const body = '{"model":"any"}';
  const headers = signedHeaders(body, "kronika", "test-secret", 1_700_000_000);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const expected = createHmac("sha256", "test-secret")
    .update(`kronika:1700000000:${bodyHash}`)
    .digest("hex");

  assert.equal(headers["x-agent-id"], "kronika");
  assert.equal(headers["x-agent-timestamp"], "1700000000");
  assert.equal(headers["x-agent-signature"], expected);
});

test("BramaClient sends a signed OpenAI-compatible completion", async (context) => {
  const agentId = "kronika-integration";
  const secret = "integration-secret";
  let observedBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      observedBody += chunk;
    });
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers["x-agent-id"], agentId);

      const timestamp = request.headers["x-agent-timestamp"];
      assert.equal(typeof timestamp, "string");
      const bodyHash = createHash("sha256").update(observedBody).digest("hex");
      const expected = createHmac("sha256", secret)
        .update(`${agentId}:${timestamp}:${bodyHash}`)
        .digest("hex");
      assert.equal(request.headers["x-agent-signature"], expected);

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "codex-subscription",
        choices: [{ message: { role: "assistant", content: "# Generated documentation" } }],
      }));
    });
  });
  context.after(() => server.close());
  const port = await listen(server);

  const client = new BramaClient({
    url: `http://127.0.0.1:${port}`,
    agentId,
    authSecret: secret,
    timeoutMs: 5_000,
  });
  const result = await client.complete({
    model: "any",
    messages: [{ role: "user", content: "Write docs" }],
    maxTokens: 1_000,
    temperature: 0.2,
  });

  assert.equal(result.content, "# Generated documentation");
  assert.equal(result.model, "codex-subscription");
  const parsedBody: unknown = JSON.parse(observedBody);
  assert.deepEqual(parsedBody, {
    model: "any",
    messages: [{ role: "user", content: "Write docs" }],
    max_tokens: 1_000,
    temperature: 0.2,
  });
});
