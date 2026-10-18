import { createHash, createHmac } from "node:crypto";

import type {
  AnswerRequest,
  AnswerResult,
  CompletionClient,
  CompletionRequest,
  CompletionResult,
} from "./types.js";

export type BramaClientOptions = {
  url: string;
  apiKey: string;
  agentId?: string;
  authSecret?: string;
  fetchImpl?: typeof fetch;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// https://tc39.es/ecma262/#eqn-MillisecondsPerSecond ("MillisecondsPerSecond = 1000")
const MILLISECONDS_PER_SECOND = 1000;

/** The message of the first choice, when the answer has one. */
const firstMessage = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined;
  const [first] = value.choices;
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return first.message;
};

const contentFromResponse = (value: unknown): string | undefined => {
  if (isRecord(value) && typeof value.content === "string") return value.content;
  const content = firstMessage(value)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts = content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    return [];
  });
  if (!parts.length) return undefined;
  return parts.join("");
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
  timestampSeconds = Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
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
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { data } = await this.#send(request, {});
    const content = contentFromResponse(data);
    if (!content?.trim()) {
      throw new Error("Brama returned no documentation content");
    }
    return withModel({ content }, data);
  }

  /**
   * The arguments of the one call of `request.answer` the model was required
   * to make. An answer without exactly that call, or whose arguments are not
   * JSON, is refused with the body Brama sent; its prose is never read.
   */
  async answer(request: AnswerRequest): Promise<AnswerResult> {
    const { name, description, parameters } = request.answer;
    const { data, text } = await this.#send(request, {
      tools: [{ type: "function", function: { name, description, strict: true, parameters } }],
      tool_choice: { type: "function", function: { name } },
    });
    const calls = firstMessage(data)?.tool_calls;
    const [call, ...others] = Array.isArray(calls) ? calls : [];
    const called = isRecord(call) && isRecord(call.function) ? call.function : undefined;
    if (others.length || called?.name !== name || typeof called.arguments !== "string") {
      throw new Error(`Brama did not answer by exactly one call of ${name}: ${text}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(called.arguments);
    } catch (error) {
      throw new Error(`Brama called ${name} with arguments that are not JSON (${(error as Error).message}): ${called.arguments}`);
    }
    return withModel({ arguments: parsed }, data);
  }

  /** One chat completion carrying `extra` beside the request; the parsed answer and its text. */
  async #send(request: CompletionRequest, extra: Record<string, unknown>): Promise<{ data: unknown; text: string }> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...extra,
    });

    // No clock on the request: it ends with Brama's answer or a transport error.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      ...(this.#agentId && this.#authSecret
        ? signedHeaders(body, this.#agentId, this.#authSecret)
        : {}),
    };
    const response = await this.#fetch(`${this.#url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body,
    });

    const text = await response.text();
    let data: unknown;
    let unparsed: string | undefined;
    try {
      data = JSON.parse(text);
    } catch (error) {
      // A refusal may carry plain text, quoted below; a success that is not
      // JSON is a damaged answer and is said to be one, not "no content".
      unparsed = (error as Error).message;
    }

    if (!response.ok) {
      const detail = errorFromResponse(data);
      throw new Error(`Brama returned HTTP ${response.status}: ${detail === undefined ? text : detail}`);
    }
    if (unparsed !== undefined) {
      throw new Error(`Brama returned HTTP ${response.status} with a body that is not JSON (${unparsed}): ${text}`);
    }
    return { data, text };
  }
}

/** `result`, with the model Brama says answered when it names one. */
const withModel = <T extends object>(result: T, data: unknown): T & { model?: string } => {
  if (isRecord(data) && typeof data.model === "string") return { ...result, model: data.model };
  return result;
};
