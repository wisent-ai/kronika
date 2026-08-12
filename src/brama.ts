import { createHash, createHmac } from "node:crypto";

import type {
  CompletionClient,
  CompletionRequest,
  CompletionResult,
} from "./types.js";

export type BramaClientOptions = {
  url: string;
  apiKey: string;
  agentId?: string;
  authSecret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentFromResponse = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.content === "string") return value.content;

  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  const content = first.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts = content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    return [];
  });
  return parts.length > 0 ? parts.join("") : undefined;
};


const errorFromResponse = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.error === "string") return value.error;
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message;
  }
  return undefined;
};

export const signedHeaders = (
  body: string,
  agentId: string,
  authSecret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Record<string, string> => {
  const timestamp = String(timestampSeconds);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const message = `${agentId}:${timestamp}:${bodyHash}`;
  const signature = createHmac("sha256", authSecret)
    .update(message)
    .digest("hex");

  return {
    "content-type": "application/json",
    "x-agent-id": agentId,
    "x-agent-timestamp": timestamp,
    "x-agent-signature": signature,
  };
};

export class BramaClient implements CompletionClient {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #agentId: string | undefined;
  readonly #authSecret: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: BramaClientOptions) {
    if (!options.url.trim()) throw new Error("Brama URL is required");
    if (!options.apiKey) throw new Error("Brama API key is required");
    if (Boolean(options.agentId) !== Boolean(options.authSecret)) {
      throw new Error("Brama agent ID and HMAC secret must be supplied together");
    }

    this.#url = options.url.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#agentId = options.agentId;
    this.#authSecret = options.authSecret;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
        ...(this.#agentId && this.#authSecret
          ? signedHeaders(body, this.#agentId, this.#authSecret)
          : {}),
      };
      response = await this.#fetch(`${this.#url}/v1/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Brama request timed out after ${this.#timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = undefined;
    }

    if (!response.ok) {
      const detail = errorFromResponse(data) ?? responseText.slice(0, 1_000);
      throw new Error(`Brama returned HTTP ${response.status}: ${detail || "empty response"}`);
    }

    const content = contentFromResponse(data);
    if (!content?.trim()) {
      throw new Error("Brama returned no documentation content");
    }

    const model = isRecord(data) && typeof data.model === "string"
      ? data.model
      : undefined;
    return model ? { content, model } : { content };
  }
}
