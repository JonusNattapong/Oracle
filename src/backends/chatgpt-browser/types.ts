export interface ChatGptBrowserConfig {
  /** Path to the Chrome user-data profile Oracle should use. */
  profileDir: string;
  /** Whether the user has explicitly enabled experimental browser mode. */
  enabled: boolean;
  /** Launch browser headed so the user can log in and watch the session. */
  headed: boolean;
  /** Response timeout in milliseconds (default: 180000). */
  timeoutMs?: number;
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
}

/** Tools selectable from the composer's plus menu. */
export type ChatGptComposerTool = "web-search";

/** Visible label each tool is listed under, and the pill it leaves behind. */
export const COMPOSER_TOOL_LABELS: Record<ChatGptComposerTool, string> = {
  "web-search": "Web search"
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
