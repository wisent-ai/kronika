import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const listen = async (server: Server): Promise<number> => {
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server has no TCP address"));
        return;
      }
      resolvePort(address.port);
    });
  });
  return port;
};

const runCli = async (
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const child = spawn(process.execPath, [resolve("dist/src/cli.js"), ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  return { code, stdout, stderr };
};

test("CLI writes documentation through a real signed Brama HTTP boundary", async (context) => {
  let observedModel = "";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload: unknown = JSON.parse(body);
      if (payload && typeof payload === "object" && "model" in payload) {
        observedModel = typeof payload.model === "string" ? payload.model : "";
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "codex-subscription",
        choices: [{ message: { content: "# CLI-generated guide\n\nVerified end to end." } }],
      }));
    });
  });
  context.after(() => server.close());
  const port = await listen(server);

  const repo = mkdtempSync(join(tmpdir(), "kronika-cli-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "service.ts"), "export const service = 'ready';\n");

  const result = await runCli([
    "write",
    "--repo", repo,
    "--source", "src",
    "--output", "docs/generated.md",
    "--model", "any",
    "--apply",
  ], {
    ...process.env,
    BRAMA_URL: `http://127.0.0.1:${port}`,
    WISENT_APP_AGENT_ID: "kronika-cli-test",
    WISENT_APP_AGENT_AUTH_SECRET: "cli-test-secret",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Wrote .*docs\/generated\.md from 1 source files via Brama/);
  assert.equal(observedModel, "any");
  assert.equal(
    readFileSync(join(repo, "docs", "generated.md"), "utf8"),
    "# CLI-generated guide\n\nVerified end to end.\n",
  );
});
