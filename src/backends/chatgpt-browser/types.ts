export interface ChatGptBrowserConfig {
  /** Path to the Chrome user-data profile Oracle should use. */
  profileDir: string;
  /** Whether the user has explicitly enabled experimental browser mode. */
  enabled: boolean;
  /** Launch browser headed so the user can log in and watch the session. */
  headed: boolean;
  /** Response timeout in milliseconds (default: 180000). */
  timeoutMs?: number;
  /** Capture conversation responses from CDP Network events before using the DOM fallback. */
  streamEnabled?: boolean;
}

export interface ChromeTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface ChromeProcessInfo {
  port: number;
  pid?: number;
  webSocketDebuggerUrl: string;
}

export interface SelectorMap {
  promptInput: string[];
  sendButton: string[];
  stopButton: string[];
  completionAction: string[];
  responseContainer: string[];
  assistantTurn: string[];
  fileInput: string[];
  attachButton: string[];
  composerMenuItem: string[];
  attachment: string[];
  modelSelector: string[];
  cloudflareChallenge: string[];
}

/** Tools selectable from the composer's plus menu. */
export type ChatGptComposerTool = "web-search" | "deep-research";

/** Visible label each tool is listed under, and the pill it leaves behind. */
export const COMPOSER_TOOL_LABELS: Record<ChatGptComposerTool, string> = {
  "web-search": "Web search",
  "deep-research": "Deep research"
};

/**
 * Floor for how long a tool's answer may take.
 *
 * Deep research runs for many minutes and spends most of them with the turn
 * unchanged, which the normal three-minute budget treats as a dead session.
 */
export const COMPOSER_TOOL_MIN_TIMEOUT_MS: Record<ChatGptComposerTool, number> = {
  "web-search": 0,
  "deep-research": 45 * 60_000
};

export interface BrowserImagePayload {
  base64: string;
  mimeType: string;
  fileName: string;
  alt?: string;
}

export interface StreamStatus {
  isStreaming: boolean;
  text: string;
  isComplete: boolean;
  error?: string;
}

export interface DiagnosticResult {
  name: string;
  ok: boolean;
  detail: string;
  screenshotPath?: string;
}
