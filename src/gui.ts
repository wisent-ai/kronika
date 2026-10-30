import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryRoot } from "./docs/sources.js";
import { initializeDocumentationWorkspace } from "./sync/project.js";
import { loadSyncManifest, type SyncManifest } from "./sync/sync.js";
import { SyncFileReadError } from "./sync/state.js";
import { recordWorkspaceInitialized } from "./onboarding/onboarding.js";

const LOOPBACK_HOST = "127.0.0.1";
// One import request carries at most 65536 bytes, the cap the GUI's contract states:
// https://kronika.wisent.com/docs/gui/#local-session-security ("JSON bodies are capped at 65536
// bytes before parsing"). How many paths it names and how long each is are the filesystem's to
// refuse, by name.
const MAX_REQUEST_BYTES = 65_536;
// The per-process session token is 256 bits, as the same contract states
// (https://kronika.wisent.com/docs/gui/#local-session-security, "a 256-bit per-process token"),
// above the 2^-160 guessing bound RFC 6749 §10.10 recommends for bearer credentials
// (https://www.rfc-editor.org/rfc/rfc6749#section-10.10).
const SESSION_TOKEN_BYTES = 256 / 8;
const ASSET_ROOT = fileURLToPath(new URL("../../gui/", import.meta.url));
// The statuses the GUI answers with, as RFC 9110 §15 numbers them
// (https://www.rfc-editor.org/rfc/rfc9110#section-15).
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL_ERROR = 500;

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
    throw new HttpError(HTTP_FORBIDDEN, "request host does not match this Kronika GUI session");
  }
  if (!sameToken(request.headers["x-kronika-token"], token)) {
    throw new HttpError(HTTP_FORBIDDEN, "Kronika GUI session token is missing or invalid");
  }
  if (mutation && request.headers.origin !== expectedOrigin) {
    throw new HttpError(HTTP_FORBIDDEN, "request origin does not match this Kronika GUI session");
  }
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(HTTP_UNSUPPORTED_MEDIA_TYPE, "request content type must be application/json");

  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new HttpError(HTTP_BAD_REQUEST, "request content length is invalid");
    }
    if (parsedLength > MAX_REQUEST_BYTES) throw new HttpError(HTTP_PAYLOAD_TOO_LARGE, `request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(HTTP_PAYLOAD_TOO_LARGE, `request exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new HttpError(HTTP_BAD_REQUEST, "request body is not valid JSON");
  }
};

const optionalPaths = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(HTTP_BAD_REQUEST, `${label} must be an array of paths`);
  const paths = value.map((entry) => {
    if (typeof entry !== "string") throw new HttpError(HTTP_BAD_REQUEST, `${label} entries must be strings`);
    const path = entry.trim();
    if (!path) throw new HttpError(HTTP_BAD_REQUEST, `${label} entries must not be empty`);
    return path;
  });
  return paths.length > 0 ? paths : undefined;
};

const parseImportRequest = (value: unknown): ImportRequest => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(HTTP_BAD_REQUEST, "request body must be a JSON object");
  }
  const input = value as Partial<Record<keyof ImportRequest, unknown>>;
  if (typeof input.manifestPath !== "string") throw new HttpError(HTTP_BAD_REQUEST, "manifestPath must be a string");
  const manifestPath = input.manifestPath.trim();
  if (!manifestPath) throw new HttpError(HTTP_BAD_REQUEST, "manifestPath must not be empty");
  if (typeof input.replace !== "boolean") throw new HttpError(HTTP_BAD_REQUEST, "replace must be a boolean");

  let instruction: string | undefined;
  if (input.instruction !== undefined) {
    if (typeof input.instruction !== "string") throw new HttpError(HTTP_BAD_REQUEST, "instruction must be a string");
    instruction = input.instruction.trim();
    // An instruction of any length is the person's: the model's context refuses what it cannot read.
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
  if (!asset) throw new HttpError(HTTP_NOT_FOUND, "not found");
  const assetPath = resolve(ASSET_ROOT, asset.file);
  const metadata = await stat(assetPath);
  response.writeHead(HTTP_OK, {
    "Content-Type": asset.contentType,
    "Content-Length": metadata.size,
  });
  createReadStream(assetPath).pipe(response);
};

const retainedProject = (manifestPath: string): SyncManifest | null => {
  try {
    return loadSyncManifest(manifestPath);
  } catch (error) {
    if (error instanceof SyncFileReadError && error.code === "ENOENT") return null;
    throw error;
  }
};

/**
 * Why the loopback listener could not open, from the operating-system code
 * Node reported (https://nodejs.org/api/errors.html#common-system-errors),
 * and what the operator does about it.
 */
const listenFailure = (error: Error, port: number | undefined): Error => {
  const code = "code" in error ? String(error.code) : "";
  const where = port === undefined ? `${LOOPBACK_HOST} on an operating-system-assigned port` : `${LOOPBACK_HOST}:${port}`;
  const head = `the graphical workspace cannot listen on ${where}`;
  const chosen = port === undefined ? "" : `, or leave --port out and the operating system assigns a free one`;
  switch (code) {
    case "EADDRINUSE":
      return new Error(port === undefined
        ? `${head}: the operating system had no free loopback port to assign (${code}); close processes holding many ephemeral ports, or pass a free --port, and start again`
        : `${head}: another process already listens there (${code}); stop that process (lsof -nP -iTCP:${port} -sTCP:LISTEN names it) or pass another --port${chosen}`);
    case "EACCES":
      return new Error(`${head}: the operating system refused this user that port (${code}); ports below 1024 are privileged on most systems, and a firewall or sandbox can refuse others; pass a --port of 1024 or more${chosen}`);
    case "EADDRNOTAVAIL":
      return new Error(`${head}: this machine has no ${LOOPBACK_HOST} interface to bind (${code}); bring the loopback interface up (on Linux: ip link set lo up) and start again`);
    case "EMFILE":
    case "ENFILE":
      return new Error(`${head}: the ${code === "EMFILE" ? "process" : "system"} has no file descriptor left for a socket (${code}); close processes holding many files or raise the limit (ulimit -n), then start again`);
    default:
      return new Error(`${head}: ${error.message}${code ? ` (${code})` : ""}; the operating system refused the socket for a reason kronika does not classify, so look up that code for this system, fix it, and start again`);
  }
};

export const startKronikaGui = async (options: GuiServerOptions): Promise<GuiServer> => {
  // A workspace over a path that is no repository would start and then reject
  // every import; it is refused before the socket opens instead.
  const repo = repositoryRoot(options.repo, "--repo");
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  let expectedHost = "";
  let expectedOrigin = "";

  const server = createServer((request, response) => {
    securityHeaders(response);
    void (async () => {
      if (!request.url) throw new HttpError(HTTP_BAD_REQUEST, "request URL is missing");
      if (request.headers.host !== expectedHost) {
        throw new HttpError(HTTP_FORBIDDEN, "request host does not match this Kronika GUI session");
      }
      const url = new URL(request.url, expectedOrigin);

      if (request.method === "GET" && ASSETS[url.pathname]) {
        await serveAsset(response, url.pathname);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        requireSession(request, expectedHost, expectedOrigin, token, false);
        sendJson(response, HTTP_OK, {
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
        const project = result.accepted
          ? loadSyncManifest(result.manifestPath)
          : retainedProject(result.manifestPath);
        const statusCode = result.conflicting.length ? HTTP_CONFLICT : result.rejected.length ? HTTP_UNPROCESSABLE : HTTP_OK;
        const onboarding = statusCode === HTTP_OK
          ? await recordWorkspaceInitialized({
            client: "gui",
            documentCount: result.imported.length + result.unchanged.length,
            manifestPath: result.manifestPath,
          })
          : undefined;
        sendJson(response, statusCode, { result: { ...result, ...(onboarding ? { onboarding } : {}) }, project });
        return;
      }
      throw new HttpError(HTTP_NOT_FOUND, "not found");
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const statusCode = error instanceof HttpError ? error.statusCode : HTTP_INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : "unexpected server error";
      sendJson(response, statusCode, { error: message });
    });
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    const onError = (error: Error): void => rejectListening(listenFailure(error, options.port));
    server.once("error", onError);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error(`the graphical workspace cannot start: Node reported its listening socket as ${JSON.stringify(address)} instead of a TCP address on ${LOOPBACK_HOST}, so no session URL can be formed; this is a Node or kronika defect, report it with this message and \`node --version\``);
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  return { server, url: `${expectedOrigin}/#token=${encodeURIComponent(token)}` };
};
