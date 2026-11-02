import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

import { firstMessage, isRecord, withModel } from "./brama.js";

import type {
  AnswerRequest,
  AnswerResult,
  CompletionClient,
  CompletionRequest,
  CompletionResult,
} from "./types.js";

/** The consumer Kronika is to Stado's capabilities. */
const CONSUMER = "kronika";

/** The command each request is handed to. */
export const STADO_CALL = ["capabilities", "call", "inference", "--consumer", CONSUMER, "--json"];

/** The `Error:` line of a failed Stado command, else its last line. */
const stadoCause = (said: string): string => {
  const lines = said.split("\n").map((line) => line.trim()).filter(Boolean).reverse();
  const error = lines.find((line) => line.startsWith("Error: "));
  return error ? error.slice("Error: ".length) : (lines[0] ?? "it said nothing");
};

/**
 * Kronika's model requests handed to Stado's inference alternatives: each
 * request goes to `stado capabilities call inference --consumer kronika`,
 * which sends it to the first alternative in Stado's selected order that
 * answers — Brama, or a statement recorded for that exact request — and
 * prints that answer. Kronika names no alternative and reads no bearer, so
 * one Stado adds is used without a change here. `STADO_BIN` names another
 * executable; the default is `stado` on PATH.
 */
export class StadoClient implements CompletionClient {
  readonly #binary: string;

  constructor(binary = process.env.STADO_BIN || "stado") {
    this.#binary = binary;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { answer, provider } = await this.#call(request, {});
    const message = firstMessage(answer);
    const content = typeof message?.content === "string" ? message.content : undefined;
    if (!content?.trim()) {
      throw new Error(`${provider} (through stado capabilities call) returned no documentation content: ${JSON.stringify(answer)}`);
    }
    return withModel({ content }, answer);
  }

  async answer(request: AnswerRequest): Promise<AnswerResult> {
    const { name, description, parameters } = request.answer;
    const { answer, provider } = await this.#call(request, {
      tools: [{ type: "function", function: { name, description, strict: true, parameters } }],
      tool_choice: { type: "function", function: { name } },
    });
    const calls = firstMessage(answer)?.tool_calls;
    const [call, ...others] = Array.isArray(calls) ? calls : [];
    const called = isRecord(call) && isRecord(call.function) ? call.function : undefined;
    if (others.length || called?.name !== name || typeof called.arguments !== "string") {
      throw new Error(`${provider} (through stado capabilities call) did not answer by exactly one call of ${name}: ${JSON.stringify(answer)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(called.arguments);
    } catch (error) {
      throw new Error(`${provider} called ${name} with arguments that are not JSON (${(error as Error).message}): ${called.arguments}`);
    }
    return withModel({ arguments: parsed }, answer);
  }

  /** Hand one chat-completions request to Stado; the answer and who gave it. */
  async #call(request: CompletionRequest, extra: Record<string, unknown>): Promise<{ answer: unknown; provider: string }> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...extra,
    });
    const operation = `${this.#binary} ${STADO_CALL.join(" ")}`;
    const pending = run(this.#binary, STADO_CALL, { encoding: "utf8", maxBuffer: Number.MAX_SAFE_INTEGER });
    pending.child.stdin?.end(body);
    let stdout: string;
    try {
      ({ stdout } = await pending);
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & { code?: unknown; stderr?: string };
      if (typeof failed.code !== "number") {
        throw new Error(`BRAMA_URL is not set and \`${operation}\` could not run (${failed.message}); install Stado or export BRAMA_URL`);
      }
      throw new Error(`BRAMA_URL is not set and no inference alternative answered \`${operation}\` (exit ${failed.code}): ${stadoCause(String(failed.stderr ?? ""))}; answer it as Stado's sentence says, or export BRAMA_URL`);
    }
    let printed: unknown;
    try {
      printed = JSON.parse(stdout);
    } catch (parse) {
      throw new Error(`\`${operation}\` printed an answer that is not JSON (${(parse as Error).message}): ${stdout}`);
    }
    const resolution = isRecord(printed) && isRecord(printed.resolution) ? printed.resolution : undefined;
    const provider = typeof resolution?.provider === "string" ? resolution.provider : "stado";
    return { answer: isRecord(printed) ? printed.answer : undefined, provider };
  }
}
