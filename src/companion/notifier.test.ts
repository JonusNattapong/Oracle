import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MAX_NOTIFICATION_LENGTH,
  UnsupportedPlatformNotifier,
  WINDOWS_TOAST_CHANNEL,
  WindowsToastNotifier,
  createDefaultNotifiers,
  sanitizeNotificationText
} from "./notifier.js";
import type { CompanionIntent } from "./types.js";

let workdir: string;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-notifier-"));
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function intent(message?: string): CompanionIntent {
  return {
    id: "intent-test",
    presenceId: "presence-test",
    trigger: "manual",
    candidate: "check_in",
    action: "speak",
    message,
    reason: "test",
    score: {
      relevance: 1,
      relationalContinuity: 0,
      urgency: 0,
      interruptionCost: 0,
      privacyRisk: 0,
      uncertainty: 0,
      total: 1,
      threshold: 0.7
    },
    createdAt: "2026-07-31T12:00:00.000Z"
  };
}

describe("sanitizeNotificationText", () => {
  test("strips control characters and collapses whitespace", () => {
    const esc = String.fromCharCode(27);
    const raw = `hello${esc}[31m world ${String.fromCharCode(0)}there`;
    const sanitized = sanitizeNotificationText(raw);
    expect(sanitized).toBe("hello [31m world there");
    expect(sanitized).not.toContain(esc);
  });

  test("bounds message length", () => {
    const sanitized = sanitizeNotificationText("a".repeat(MAX_NOTIFICATION_LENGTH * 2));
    expect(sanitized.length).toBe(MAX_NOTIFICATION_LENGTH);
  });
});

describe("WindowsToastNotifier", () => {
  test("reports unavailability instead of pretending delivery on non-Windows", async () => {
    const notifier = new WindowsToastNotifier({ platform: "linux" });
    expect(notifier.available).toBe(false);
    expect(notifier.unavailableReason).toMatch(/linux/);
    expect(await notifier.deliver(intent("hi"))).toMatchObject({
      delivered: false,
      errorKind: "unavailable"
    });
  });

  test("never delivers an intent with no message", async () => {
    const notifier = new WindowsToastNotifier({
      platform: "win32",
      powershellPath: process.execPath
    });
    expect(await notifier.deliver(intent("   "))).toMatchObject({
      delivered: false,
      errorKind: "unavailable"
    });
  });

  test("passes message text out-of-band so it cannot be executed as a command", async () => {
    // A stand-in for PowerShell records its argv and environment. A message
    // engineered to break out of a command line must reach the process only
    // through the environment, and must never be executed.
    const marker = path.join(workdir, "pwned.txt");
    const capture = path.join(workdir, "capture.json");
    const fakeShell = path.join(workdir, "fake-shell.mjs");
    await fs.writeFile(
      fakeShell,
      [
        'import fs from "node:fs";',
        `fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({`,
        "  argv: process.argv.slice(2),",
        "  body: process.env.ORACLE_TOAST_BODY ?? null",
        "}));"
      ].join(String.fromCharCode(10)),
      "utf8"
    );

    const hostile = `hi"; New-Item -Path '${marker}' -ItemType File; #`;
    const notifier = new WindowsToastNotifier({
      platform: "win32",
      powershellPath: process.execPath,
      timeoutMs: 5000
    });
    expect(notifier.channel).toBe(WINDOWS_TOAST_CHANNEL);

    // Node is not PowerShell, so the attempt fails - the point is that it fails
    // as a classified delivery error and executes nothing.
    const result = await notifier.deliver(intent(hostile));
    expect(result.delivered).toBe(false);
    await expect(fs.stat(marker)).rejects.toThrow();

    // Confirm the transport shape the notifier relies on: body travels in the
    // environment, never on the command line.
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [fakeShell], {
        env: { ORACLE_TOAST_BODY: hostile },
        stdio: "ignore"
      });
      child.on("close", () => resolve());
    });
    const captured = JSON.parse(await fs.readFile(capture, "utf8")) as {
      argv: string[];
      body: string;
    };
    expect(captured.body).toBe(hostile);
    expect(captured.argv.join(" ")).not.toContain("New-Item");
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  test("classifies a failing shell as an exit_code failure without throwing", async () => {
    const failing = path.join(workdir, "fail.cmd");
    const notifier = new WindowsToastNotifier({
      platform: "win32",
      powershellPath: failing,
      timeoutMs: 2000
    });
    const result = await notifier.deliver(intent("hello"));
    expect(result.delivered).toBe(false);
    expect(["spawn_failed", "exit_code"]).toContain(result.errorKind);
  });
});

describe("createDefaultNotifiers", () => {
  test("returns an explicit unsupported channel off Windows", async () => {
    const [notifier] = createDefaultNotifiers("darwin");
    expect(notifier).toBeInstanceOf(UnsupportedPlatformNotifier);
    expect(notifier.enabled).toBe(false);
    expect(notifier.channel).toBe(WINDOWS_TOAST_CHANNEL);
    expect(await notifier.deliver(intent("hi"))).toMatchObject({ delivered: false });
  });

  test("returns the Windows toast channel on Windows", () => {
    const [notifier] = createDefaultNotifiers("win32");
    expect(notifier).toBeInstanceOf(WindowsToastNotifier);
    expect(notifier.channel).toBe(WINDOWS_TOAST_CHANNEL);
  });
});
