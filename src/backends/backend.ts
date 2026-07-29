import type { ImageArtifact, TokenUsage } from "../types.js";

export interface ExecutionBackendCapabilities {
  consult: boolean;
  toolUse: boolean;
  images: boolean;
  continuation: boolean;
  /** Can explicitly write a high-level fact to the signed-in account's saved memory. */
  accountMemory?: boolean;
  structuredUsage: boolean;
  /** Platforms this backend can run on. */
  supportedPlatforms: readonly NodeJS.Platform[];
}

export interface ExecutionBackendRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  previousResponseId?: string;
  /** Exact user-authorized text to save to the signed-in account's memory. */
  accountMemory?: string;
  images?: Array<{ base64: string; mimeType: string; fileName: string }>;
  /** Session-owned directory where the backend may persist generated artifacts. */
  artifactsDir?: string;
}

export interface ExecutionBackendResponse {
  responseId?: string;
  text: string;
  usage: TokenUsage;
  /** True only when the backend received an explicit successful save confirmation. */
  accountMemorySaved?: boolean;
  images?: ImageArtifact[];
  artifactWarnings?: string[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ExecutionBackend {
  readonly id: string;
  readonly capabilities: ExecutionBackendCapabilities;
  /** Run a single consult turn. */
  run(request: ExecutionBackendRequest): Promise<ExecutionBackendResponse>;
  /** Health/credential checks for this backend. */
  healthCheck(): Promise<DoctorCheck[]>;
}
