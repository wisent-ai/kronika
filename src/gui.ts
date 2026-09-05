import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initializeDocumentationWorkspace } from "./project.js";
import { loadSyncManifest, type SyncManifest } from "./sync.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SELECTIONS = 256;
const MAX_PATH_LENGTH = 4_096;
const MAX_INSTRUCTION_LENGTH = 16_384;
const ASSET_ROOT = fileURLToPath(new URL("../../gui/", import.meta.url));

const ASSETS: Readonly<Record<string, { file: string; contentType: string }>> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
};

type ImportRequest = {
  documents?: string[];
  sources?: string[];
  manifestPath: string;
  instruction?: string;
  replace: boolean;
};

export type GuiServerOptions = {
  repo: string;
  port?: number;
};

export type GuiServer = {
  server: Server;
  url: string;
};

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const securityHeaders = (response: ServerResponse): void => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
};

const sendJson = (response: ServerResponse, statusCode: number, value: unknown): void => {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
};

const sameToken = (candidate: string | string[] | undefined, token: string): boolean => {
  if (typeof candidate !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
};

const requireSession = (
  request: IncomingMessage,
  expectedHost: string,
  expectedOrigin: string,
  token: string,
  mutation: boolean,
): void => {
  if (request.headers.host !== expectedHost) {
    throw new HttpError(403, "request host does not match this Kronika GUI session");
  }
  if (!sameToken(request.headers["x-kronika-token"], token)) {
    throw new HttpError(403, "Kronika GUI session token is missing or invalid");
  }
  if (mutation && request.headers.origin !== expectedOrigin) {
    throw new HttpError(403, "request origin does not match this Kronika GUI session");
  }
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "request content type must be application/json");

  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new HttpError(400, "request content length is invalid");
    }
    if (parsedLength > MAX_REQUEST_BYTES) throw new HttpError(413, `request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, `request exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
};

const optionalPaths = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SELECTIONS) {
    throw new HttpError(400, `${label} must be an array of at most ${MAX_SELECTIONS} paths`);
  }
  const paths = value.map((entry) => {
    if (typeof entry !== "string") throw new HttpError(400, `${label} entries must be strings`);
    const path = entry.trim();
    if (!path || path.length > MAX_PATH_LENGTH) {
      throw new HttpError(400, `${label} entries must contain 1 to ${MAX_PATH_LENGTH} characters`);
    }
    return path;
  });
  return paths.length > 0 ? paths : undefined;
};

const parseImportRequest = (value: unknown): ImportRequest => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const input = value as Partial<Record<keyof ImportRequest, unknown>>;
  if (typeof input.manifestPath !== "string") throw new HttpError(400, "manifestPath must be a string");
  const manifestPath = input.manifestPath.trim();
  if (!manifestPath || manifestPath.length > MAX_PATH_LENGTH) {
    throw new HttpError(400, `manifestPath must contain 1 to ${MAX_PATH_LENGTH} characters`);
  }
  if (typeof input.replace !== "boolean") throw new HttpError(400, "replace must be a boolean");

  let instruction: string | undefined;
  if (input.instruction !== undefined) {
    if (typeof input.instruction !== "string") throw new HttpError(400, "instruction must be a string");
    instruction = input.instruction.trim();
    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
      throw new HttpError(400, `instruction must contain at most ${MAX_INSTRUCTION_LENGTH} characters`);
    }
    if (!instruction) instruction = undefined;
  }

  const documents = optionalPaths(input.documents, "documents");
  const sources = optionalPaths(input.sources, "sources");
  return {
    ...(documents ? { documents } : {}),
    ...(sources ? { sources } : {}),
    manifestPath,
    ...(instruction ? { instruction } : {}),
    replace: input.replace,
  };
};

const serveAsset = async (response: ServerResponse, path: string): Promise<void> => {
  const asset = ASSETS[path];
  if (!asset) throw new HttpError(404, "not found");
  const assetPath = resolve(ASSET_ROOT, asset.file);
  const metadata = await stat(assetPath);
  response.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": metadata.size,
  });
  createReadStream(assetPath).pipe(response);
};

const retainedProject = (manifestPath: string): SyncManifest | null => {
  try {
    return loadSyncManifest(manifestPath);
  } catch {
    return null;
  }
};

export const startKronikaGui = async (options: GuiServerOptions): Promise<GuiServer> => {
  const repo = resolve(options.repo);
  const token = randomBytes(32).toString("base64url");
  let expectedHost = "";
  let expectedOrigin = "";

  const server = createServer((request, response) => {
    securityHeaders(response);
    void (async () => {
      if (!request.url) throw new HttpError(400, "request URL is missing");
      if (request.headers.host !== expectedHost) {
        throw new HttpError(403, "request host does not match this Kronika GUI session");
      }
      const url = new URL(request.url, expectedOrigin);

      if (request.method === "GET" && ASSETS[url.pathname]) {
        await serveAsset(response, url.pathname);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        requireSession(request, expectedHost, expectedOrigin, token, false);
        sendJson(response, 200, {
          repo,
          defaults: {
            manifestPath: "kronika.sync.json",
            documents: [],
            sources: [],
          },
          requestLimitBytes: MAX_REQUEST_BYTES,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/import") {
        requireSession(request, expectedHost, expectedOrigin, token, true);
        const input = parseImportRequest(await readJson(request));
        const result = initializeDocumentationWorkspace({
          repo,
          manifestPath: input.manifestPath,
          ...(input.documents ? { documents: input.documents } : {}),
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.instruction ? { instruction: input.instruction } : {}),
          replace: input.replace,
        });
        const project = result.status === "imported" || result.status === "unchanged"
          ? loadSyncManifest(result.manifestPath)
          : retainedProject(result.manifestPath);
        const statusCode = result.status === "conflicting" ? 409 : result.status === "rejected" ? 422 : 200;
        sendJson(response, statusCode, { result, project });
        return;
      }
      throw new HttpError(404, "not found");
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : "unexpected server error";
      sendJson(response, statusCode, { error: message });
    });
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolveListening, rejectListening) => {
    const onError = (error: Error): void => rejectListening(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Kronika GUI did not receive a TCP address");
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  return { server, url: `${expectedOrigin}/#token=${encodeURIComponent(token)}` };
};
