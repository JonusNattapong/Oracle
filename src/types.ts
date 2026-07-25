export interface ContextFile {
  path: string;
  content: string;
  sizeBytes: number;
  base64?: string;
  mimeType?: string;
}

export interface ConsultRequest {
  prompt: string;
  files?: string[];
  model?: string;
  provider?: string;
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
