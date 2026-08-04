export interface ContextFile {
  path: string;
  content: string;
  sizeBytes: number;
  base64?: string;
  mimeType?: string;
}

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageArtifact {
  path: string;
  mimeType: SupportedImageMimeType;
  sizeBytes: number;
  fileName: string;
  alt?: string;
}

export interface ConsultRequest {
  prompt: string;
  /**
   * The user's own question, when `prompt` also carries retrieved context.
   * Session ids are slugged from it, so recalled memory prepended to the prompt
   * does not make every session read as the same thing. Defaults to `prompt`.
   */
  title?: string;
  files?: string[];
  model?: string;
  provider?: string;
  /** Stable logical conversation. Continuation-capable backends resume its latest response. */
  conversationId?: string;
  /**
   * Exact high-level fact or preference explicitly authorized for the signed-in
   * backend account. It is not added to bundles or persisted as session text.
   */
  accountMemory?: string;
  /** Composer tool to engage for this turn; backends that cannot honour it fail. */
  tool?: "web-search" | "deep-research";
  preset?: string;
  systemPrompt?: string;
  cwd?: string;
  maxFileSizeBytes?: number;
  maxInputBytes?: number;
  previousResponseId?: string;
  allowEmptyFiles?: boolean;
  /** Attribution for cost accounting; unset calls are reported as unattributed. */
  agent?: string;
  /** Compress context files into AST signature skeletons to optimize token usage */
  compressContext?: boolean;
  /** Specific file paths to compress into AST signature skeletons */
  compressFiles?: string[];
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderResponse {
  responseId?: string;
  text: string;
  usage: TokenUsage;
}

export interface ConsultResult {
  sessionId: string;
  status: "completed" | "error";
  model: string;
  provider?: string;
  preset?: string;
  files: string[];
  estimatedInputTokens?: number;
  responseId?: string;
  conversationId?: string;
  accountMemoryRequested?: boolean;
  /** True only when the write was confirmed against the account itself. */
  accountMemorySaved?: boolean;
  /** Distinguishes a checked save from one that could not be verified. */
  accountMemoryVerification?: "verified" | "unverified" | "not-attempted";
  images?: ImageArtifact[];
  artifactWarnings?: string[];
  output: string;
  usage: TokenUsage;
  error?: string;
}

export interface SessionRecord extends ConsultResult {
  createdAt: string;
  completedAt?: string;
  cwd: string;
  prompt: string;
  bundlePath: string;
}
