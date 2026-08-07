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
export type ChatGptComposerTool = "web-search" | "deep-research" | "create-image";

/** Visible label each tool is listed under, and the pill it leaves behind. */
export const COMPOSER_TOOL_LABELS: Record<ChatGptComposerTool, string> = {
  "web-search": "Web search",
  "deep-research": "Deep research",
  "create-image": "Create image"
};

/**
 * Floor for how long a tool's answer may take.
 *
 * Deep research runs for many minutes and spends most of them with the turn
 * unchanged, which the normal three-minute budget treats as a dead session.
 * Image generation is shorter but has the same shape: one long render with no
 * incremental text to prove the turn is alive.
 */
export const COMPOSER_TOOL_MIN_TIMEOUT_MS: Record<ChatGptComposerTool, number> = {
  "web-search": 0,
  "deep-research": 45 * 60_000,
  "create-image": 5 * 60_000
};

/**
 * Tools whose turn must not be rescued by a page reload. Their turn sits
 * unchanged by design, and reloading discards the work rather than unwedging a
 * stuck UI — a generated image is lost, not re-rendered.
 */
export const COMPOSER_TOOLS_WITHOUT_STALL_RELOAD: ReadonlySet<ChatGptComposerTool> = new Set([
  "deep-research",
  "create-image"
]);

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
