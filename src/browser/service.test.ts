import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  buildBrowserServiceInvocation,
  formatBrowserServiceInvocation,
  runBrowserService
} from "./service.js";

describe("browser service", () => {
  test("builds the pinned upstream serve invocation and redacts its token", () => {
    const invocation = buildBrowserServiceInvocation(
      {
        host: "127.0.0.1",
        port: 9473,
        token: "secret-token",
        manualLogin: true,
        profileDir: "C:/Oracle Browser",
        cwd: "D:/workspace"
      },
      {
        platform: "linux",
        execPath: "/usr/bin/node"
      }
    );

    expect(invocation.args).toEqual([
      "-y",
      "@steipete/oracle@0.16.1",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "9473",
      "--token",
      "secret-token",
      "--manual-login",
      "--manual-login-profile-dir",
      "C:/Oracle Browser"
    ]);
    expect(formatBrowserServiceInvocation(invocation)).not.toContain("secret-token");
    expect(formatBrowserServiceInvocation(invocation)).toContain("<redacted>");
  });

  test("returns the child exit code and uses inherited foreground IO", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { killed: false, kill: vi.fn() });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await expect(
      runBrowserService(
        {
          host: "127.0.0.1",
          port: 9473,
          manualLogin: true,
          cwd: "D:/workspace"
        },
        spawnProcess
      )
    ).resolves.toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["serve", "--host", "127.0.0.1"]),
      expect.objectContaining({
        cwd: "D:/workspace",
        stdio: "inherit",
        windowsHide: false
      })
    );
  });

  test("forwards Ctrl+C and reports an interrupted exit", async () => {
    const child = new EventEmitter() as ChildProcess;
    const kill = vi.fn();
    Object.assign(child, { killed: false, kill });
    const running = runBrowserService(
      {
        host: "127.0.0.1",
        port: 9473,
        manualLogin: true,
        cwd: "D:/workspace"
      },
      () => child
    );

    process.emit("SIGINT");
    expect(kill).toHaveBeenCalledWith("SIGINT");
    child.emit("close", null, "SIGINT");
    await expect(running).resolves.toBe(130);
  });
});
