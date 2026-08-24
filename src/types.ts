export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionRequest = {
  messages: ChatMessage[];
  model: string;
  maxTokens: number;
};

export type CompletionResult = {
  content: string;
  model?: string;
};

export interface CompletionClient {
  complete(request: CompletionRequest): Promise<CompletionResult>;
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
  maxTokens: number;
  maxDiffBytes: number;
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
  maxInputBytes: number;
  maxFileBytes: number;
};

export type WriteDocumentationOptions = SourceOptions & {
  instruction?: string;
  model: string;
  maxTokens: number;
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
