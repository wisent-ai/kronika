import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { buildDocumentationMessages } from "./prompt.js";
import { collectSources } from "./sources.js";
import type {
  CompletionClient,
  WriteDocumentationOptions,
  WriteDocumentationResult,
} from "./types.js";

const normalizeModelOutput = (content: string): string => {
  let normalized = content.trim();
  const fenced = normalized.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced?.[1]) normalized = fenced[1].trim();
  if (normalized.length < 20) throw new Error("Brama returned documentation that is too short");
  if (normalized.includes("\0")) throw new Error("Brama returned invalid NUL content");
  return `${normalized}\n`;
};

const writeAtomically = (outputPath: string, content: string): void => {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.kronika-${randomUUID()}.tmp`;
  const mode = existsSync(outputPath) ? statSync(outputPath).mode & 0o777 : 0o644;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, outputPath);
  } catch (error: unknown) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
};

export const writeDocumentation = async (
  options: WriteDocumentationOptions,
  client: CompletionClient,
): Promise<WriteDocumentationResult> => {
  const repo = resolve(options.repo);
  const outputPath = resolve(repo, options.output);
  const outputFromRepo = relative(repo, outputPath);
  if (
    outputFromRepo === ".." ||
    outputFromRepo.startsWith(`..${sep}`) ||
    outputFromRepo.startsWith(sep)
  ) {
    throw new Error(`Output is outside the repository: ${options.output}`);
  }

  const collection = collectSources(options);
  if (collection.documents.length === 0) {
    throw new Error("No safe UTF-8 source files were selected");
  }

  const completion = await client.complete({
    messages: buildDocumentationMessages(options, collection),
    model: options.model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });
  const content = normalizeModelOutput(completion.content);
  if (options.apply) writeAtomically(outputPath, content);

  const result = {
    content,
    outputPath,
    applied: options.apply,
    sources: collection.documents,
    skipped: collection.skipped,
  };
  return completion.model ? { ...result, model: completion.model } : result;
};
