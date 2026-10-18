export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionRequest = {
  messages: ChatMessage[];
  model: string;
  /** Completion budget; absent, the request names none and the alias's own limit applies. */
  maxTokens?: number;
};

export type CompletionResult = {
  content: string;
  model?: string;
};

/** The function a model answers by calling: its parameters are a strict JSON Schema. */
export type AnswerFunction = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AnswerRequest = CompletionRequest & { answer: AnswerFunction };

/** The arguments of the one call the model made, parsed, and the model that made it. */
export type AnswerResult = {
  arguments: unknown;
  model?: string;
};

export interface CompletionClient {
  /** Free text: documentation a person reads. */
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** A decision: the arguments of one required call of `request.answer`. */
  answer(request: AnswerRequest): Promise<AnswerResult>;
}

export type SourceDocument = {
  path: string;
  content: string;
  bytes: number;
};

export type SkippedSource = {
  path: string;
  reason: string;
};

export type SourceCollection = {
  documents: SourceDocument[];
  skipped: SkippedSource[];
  totalBytes: number;
};

export type DocumentationFinding = {
  severity: "blocker" | "warning";
  code: string;
  document: string | null;
  sourcePaths: string[];
  message: string;
  requiredChange: string | null;
};

export type CheckDocumentationOptions = SourceOptions & {
  base: string;
  head: string;
  instruction?: string;
  model: string;
  /** Completion budget; absent, the Brama alias's own limit applies. */
  maxTokens?: number;
  /** Git diff bytes; absent, the whole diff is audited. */
  maxDiffBytes?: number;
  /** Git pathspecs the audited diff is restricted to; empty audits the whole
   * range. Sync passes the document's declared sources here so one drifted
   * document is never blocked by the size of unrelated changes. */
  diffPaths?: string[];
};

export type CheckDocumentationResult = {
  passed: boolean;
  summary: string;
  findings: DocumentationFinding[];
  model?: string;
  baseSha: string;
  headSha: string;
  changedPaths: string[];
  diffBytes: number;
  sources: SourceDocument[];
  skipped: SkippedSource[];
};

export type SourceOptions = {
  repo: string;
  sources?: string[];
  output: string;
  /** Total source payload; absent, every selected source is read. */
  maxInputBytes?: number;
  /** One source file; absent, no file is skipped for its size. */
  maxFileBytes?: number;
};

export type WriteDocumentationOptions = SourceOptions & {
  instruction?: string;
  model: string;
  /** Completion budget; absent, the Brama alias's own limit applies. */
  maxTokens?: number;
  apply: boolean;
};

export type WriteDocumentationResult = {
  content: string;
  model?: string;
  outputPath: string;
  applied: boolean;
  sources: SourceDocument[];
  skipped: SkippedSource[];
};
