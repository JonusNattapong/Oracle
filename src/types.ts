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
  preset?: string;
  systemPrompt?: string;
  cwd?: string;
  maxFileSizeBytes?: number;
  maxInputBytes?: number;
  previousResponseId?: string;
  allowEmptyFiles?: boolean;
  /** Attribution for cost accounting; unset calls are reported as unattributed. */
  agent?: string;
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
  accountMemorySaved?: boolean;
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
