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
  /**
   * Composer tool to engage for this turn (currently `web-search`). Backends
   * that cannot honour it must fail rather than answer without it.
   */
  tool?: "web-search" | "deep-research";
  images?: Array<{ base64: string; mimeType: string; fileName: string }>;
  /** Session-owned directory where the backend may persist generated artifacts. */
  artifactsDir?: string;
}

/**
 * How much is actually known about an account-memory write.
 * - `verified`   — the account was inspected and contains the entry.
 * - `unverified` — the backend was told it saved, but the account could not be
 *   inspected to confirm it. Not a success claim.
 * - `not-attempted` — no account memory was requested.
 */
export type AccountMemoryVerification = "verified" | "unverified" | "not-attempted";

export interface ExecutionBackendResponse {
  responseId?: string;
  text: string;
  usage: TokenUsage;
  /**
   * True only when the write was confirmed against the account itself. A model
   * saying "saved" is not sufficient: that claim has been observed for entries
   * the account never stored. See `accountMemoryVerification` to tell a checked
   * success from an unverifiable one.
   */
  accountMemorySaved?: boolean;
  accountMemoryVerification?: AccountMemoryVerification;
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
