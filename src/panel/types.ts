import type { TokenUsage } from "../types.js";

export interface PanelMember {
  /** Stable label for this seat on the panel. Unique within one panel. */
  id: string;
  backend: string;
  model?: string;
}

export interface PanelMemberResult {
  id: string;
  backend: string;
  model?: string;
  status: "completed" | "error";
  sessionId?: string;
  output?: string;
  error?: string;
  usage?: TokenUsage;
  durationMs: number;
}

/**
 * `partial` is a first-class outcome, not a failure: an advisory panel that
 * loses one member still returned advice. Callers that need every member are
 * expected to check this field rather than rely on an exit code alone.
 */
export type PanelStatus = "complete" | "partial" | "failed";

export interface PanelManifest {
  version: number;
  id: string;
  createdAt: string;
  completedAt: string;
  durationMs: number;
  prompt: string;
  cwd: string;
  status: PanelStatus;
  requested: number;
  succeeded: number;
  failed: number;
  members: PanelMemberResult[];
}

export const PANEL_MANIFEST_VERSION = 1;
