import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type {
  CompanionIntent,
  CompanionNotifier,
  DeliveryResult
} from "./types.js";

export const WINDOWS_TOAST_CHANNEL = "windows-toast";

/**
 * Longest message a channel will carry. Intents are locally generated, but the
 * bound keeps a malformed or future model-generated message from producing an
 * oversized toast payload.
 */
export const MAX_NOTIFICATION_LENGTH = 400;

const TOAST_TITLE = "Oracle";
const TOAST_TIMEOUT_MS = 10_000;

/**
 * Shell AppID registered for Windows PowerShell. Using an existing AppID avoids
 * writing a Start Menu shortcut just to raise a toast.
 */
const TOAST_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * A fixed script: the intent message is never interpolated into it. Text
 * crosses into PowerShell through environment variables only, and is
 * XML-escaped there, so no message content can be parsed as script or markup.
 */
const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$title = [System.Security.SecurityElement]::Escape($env:ORACLE_TOAST_TITLE)
$body = [System.Security.SecurityElement]::Escape($env:ORACLE_TOAST_BODY)
$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$document.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $document
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:ORACLE_TOAST_APP_ID).Show($toast)
`;

export interface WindowsToastNotifierOptions {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  /** Injected for tests; defaults to the real PowerShell executable. */
  powershellPath?: string;
  timeoutMs?: number;
}

/**
 * Truncates and normalizes message text. Control characters are stripped so a
 * message cannot smuggle terminal escapes into logs or the toast body.
 */
export function sanitizeNotificationText(value: string): string {
  const stripped = Array.from(value)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : char;
    })
    .join("")
    .replace(/[ \t\n\r]+/g, " ")
    .trim();
  return stripped.length > MAX_NOTIFICATION_LENGTH
    ? `${stripped.slice(0, MAX_NOTIFICATION_LENGTH - 1)}…`
    : stripped;
}

function resolvePowershell(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Delivers a local Windows toast. Nothing leaves the machine, and a failure is
 * reported as a classified result rather than thrown, so the Runtime stays
 * healthy when notifications are unavailable.
 */
export class WindowsToastNotifier implements CompanionNotifier {
  readonly channel = WINDOWS_TOAST_CHANNEL;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly unavailableReason?: string;

  private readonly powershellPath: string;
  private readonly timeoutMs: number;

  constructor(options: WindowsToastNotifierOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.enabled = options.enabled ?? true;
    this.available = platform === "win32";
    if (!this.available) {
      this.unavailableReason =
        `Windows toast notifications are unavailable on platform "${platform}".`;
    }
    this.powershellPath = options.powershellPath ?? resolvePowershell();
    this.timeoutMs = options.timeoutMs ?? TOAST_TIMEOUT_MS;
  }

  async deliver(intent: CompanionIntent): Promise<DeliveryResult> {
    if (!this.available) {
      return {
        delivered: false,
        errorKind: "unavailable",
        detail: this.unavailableReason
      };
    }
    const body = sanitizeNotificationText(intent.message ?? "");
    if (!body) {
      return {
        delivered: false,
        errorKind: "unavailable",
        detail: "Intent carried no deliverable message."
      };
    }
    return this.runToast(body);
  }

  private runToast(body: string): Promise<DeliveryResult> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (result: DeliveryResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          this.powershellPath,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            TOAST_SCRIPT
          ],
          {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
            env: {
              SystemRoot: process.env.SystemRoot ?? "",
              windir: process.env.windir ?? "",
              PATHEXT: process.env.PATHEXT ?? "",
              TEMP: process.env.TEMP ?? os.tmpdir(),
              ORACLE_TOAST_TITLE: TOAST_TITLE,
              ORACLE_TOAST_BODY: body,
              ORACLE_TOAST_APP_ID: TOAST_APP_ID
            }
          }
        );
      } catch (error) {
        settle({
          delivered: false,
          errorKind: "spawn_failed",
          detail: error instanceof Error ? error.name : "spawn failed"
        });
        return;
      }

      timer = setTimeout(() => {
        child.kill();
        settle({
          delivered: false,
          errorKind: "timeout",
          detail: `Toast delivery exceeded ${this.timeoutMs}ms.`
        });
      }, this.timeoutMs);
      timer.unref?.();

      let stderr = "";
      const onStderr = (chunk: Buffer) => {
        if (stderr.length < 500) stderr += chunk.toString("utf8");
      };
      const onError = (error: Error) => {
        settle({
          delivered: false,
          errorKind: "spawn_failed",
          detail: error instanceof Error ? error.name : "spawn failed"
        });
      };
      const onClose = (code: number | null) => {
        if (code === 0) {
          settle({ delivered: true });
          return;
        }
        settle({
          delivered: false,
          errorKind: "exit_code",
          detail: sanitizeNotificationText(
            `PowerShell exited with code ${code}. ${stderr}`
          )
        });
      };

      child.stderr?.on("data", onStderr);
      child.on("error", onError);
      child.on("close", onClose);

      const cleanup = () => {
        child.stderr?.removeListener("data", onStderr);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
      };
    });
  }
}

/**
 * Explicit stand-in for platforms with no local channel. It never reports a
 * successful delivery, so absence of a channel can't be mistaken for silence.
 */
export class UnsupportedPlatformNotifier implements CompanionNotifier {
  readonly enabled = false;
  readonly available = false;
  readonly unavailableReason: string;

  constructor(readonly channel: string, platform: NodeJS.Platform = process.platform) {
    this.unavailableReason = `No local notification channel is implemented for "${platform}".`;
  }

  async deliver(): Promise<DeliveryResult> {
    return {
      delivered: false,
      errorKind: "unavailable",
      detail: this.unavailableReason
    };
  }
}

export function createDefaultNotifiers(
  platform: NodeJS.Platform = process.platform
): CompanionNotifier[] {
  return platform === "win32"
    ? [new WindowsToastNotifier({ platform })]
    : [new UnsupportedPlatformNotifier(WINDOWS_TOAST_CHANNEL, platform)];
}
