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
