import fs from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  BROWSER_RUNTIME_PACKAGE,
  BrowserProvider,
  resolveBrowserRuntimeInvocation
} from "./browser.js";
import type { CommandRunner } from "./codex.js";

describe("resolveBrowserRuntimeInvocation", () => {
  test("uses the npm npx entrypoint directly on Windows", () => {
    expect(
      resolveBrowserRuntimeInvocation(["--version"], {
        platform: "win32",
        execPath: "C:/Program Files/nodejs/node.exe",
        appData: "C:/Users/Test/AppData/Roaming"
      })
    ).toEqual({
      command: "C:/Program Files/nodejs/node.exe",
      args: [
        "C:/Users/Test/AppData/Roaming/npm/node_modules/npm/bin/npx-cli.js",
        "-y",
        BROWSER_RUNTIME_PACKAGE,
        "--version"
      ]
    });
  });
});

describe("BrowserProvider", () => {
  test("forwards auto-reattach and bridge settings to the browser runtime", async () => {
    const runner: CommandRunner = vi.fn(async (_command, args, options) => {
      const outputPath = args[args.indexOf("--write-output") + 1];
      await fs.writeFile(outputPath, "Browser answer", "utf8");
      expect(options.input).toBe("system\n\nuser");
      expect(options.env).toEqual({ ORACLE_REMOTE_TOKEN: "secret-token" });
      expect(args).not.toContain("secret-token");
      return { exitCode: 0, stdout: "Session: upstream-browser-session\n", stderr: "" };
    });
    const provider = new BrowserProvider({
      runner,
      autoReattachDelay: "5s",
      autoReattachInterval: "3s",
      autoReattachTimeout: "60s",
      remoteChrome: "127.0.0.1:9222",
      remoteHost: "127.0.0.1:9473",
      remoteToken: "secret-token",
      manualLogin: true,
      attachRunning: true,
      keepBrowser: true,
      port: "9223",
      hideWindow: true,
      modelStrategy: "current",
      thinkingTime: "heavy",
      followUps: ["Challenge the recommendation"],
      archive: "never",
      attachments: "always",
      bundleFiles: true,
      bundleFormat: "zip",
      attachmentTimeout: "2m",
      maxConcurrentTabs: "2"
    });

    const response = await provider.run({
      model: "gpt-5.5-pro",
      systemPrompt: "system",
      userPrompt: "user",
      cwd: "D:/workspace",
      previousResponseId: "parent-browser-session"
    });

    expect(runner).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        BROWSER_RUNTIME_PACKAGE,
        "--engine",
        "browser",
        "--browser-auto-reattach-delay",
        "5s",
        "--browser-auto-reattach-interval",
        "3s",
        "--browser-auto-reattach-timeout",
        "60s",
        "--remote-host",
        "127.0.0.1:9473",
        "--browser-model-strategy",
        "current",
        "--browser-thinking-time",
        "heavy",
        "--browser-follow-up",
        "Challenge the recommendation",
        "--browser-archive",
        "never",
        "--browser-attachments",
        "always",
        "--browser-bundle-files",
        "--browser-bundle-format",
        "zip",
        "--browser-attachment-timeout",
        "2m",
        "--browser-max-concurrent-tabs",
        "2",
        "--followup",
        "parent-browser-session"
      ]),
      expect.objectContaining({ cwd: "D:/workspace" })
    );
    const forwardedArgs = vi.mocked(runner).mock.calls[0][1];
    expect(forwardedArgs).not.toContain("--remote-chrome");
    expect(forwardedArgs).not.toContain("--browser-manual-login");
    expect(forwardedArgs).not.toContain("--browser-attach-running");
    expect(forwardedArgs).not.toContain("--browser-keep-browser");
    expect(forwardedArgs).not.toContain("--browser-port");
    expect(forwardedArgs).not.toContain("--browser-hide-window");
    expect(response).toEqual({
      responseId: "upstream-browser-session",
      text: "Browser answer",
      usage: {}
    });
  });
});
