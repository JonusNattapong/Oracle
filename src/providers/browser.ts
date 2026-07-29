import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderResponse } from "../types.js";
import type { CommandRunner } from "./codex.js";
import { runCommand } from "./codex.js";
import type { Provider, ProviderRequest } from "./provider.js";

export const BROWSER_RUNTIME_PACKAGE = "@steipete/oracle@0.16.1";

export interface BrowserProviderOptions {
  autoReattachDelay?: string;
  autoReattachInterval?: string;
  autoReattachTimeout?: string;
  browserTimeout?: string;
  browserInputTimeout?: string;
  manualLogin?: boolean;
  keepBrowser?: boolean;
  attachRunning?: boolean;
  remoteChrome?: string;
  remoteHost?: string;
  remoteToken?: string;
  chatgptUrl?: string;
  modelStrategy?: "select" | "current" | "ignore";
  tab?: string;
  thinkingTime?: "light" | "standard" | "extended" | "heavy";
  research?: "deep";
  followUps?: string[];
  archive?: "auto" | "always" | "never";
  attachments?: "auto" | "never" | "always";
  bundleFiles?: boolean;
  bundleFormat?: "auto" | "text" | "zip";
  port?: string;
  attachmentTimeout?: string;
  recheckDelay?: string;
  recheckTimeout?: string;
  heartbeat?: string;
  reuseWait?: string;
  profileLockTimeout?: string;
  maxConcurrentTabs?: string;
  hideWindow?: boolean;
  runner?: CommandRunner;
}

interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  execPath: string;
  appData?: string;
}

export function resolveBrowserRuntimeInvocation(
  args: string[],
  environment: RuntimeEnvironment
): { command: string; args: string[] } {
  if (environment.platform !== "win32" || !environment.appData) {
    return { command: "npx", args: ["-y", BROWSER_RUNTIME_PACKAGE, ...args] };
  }
  return {
    command: environment.execPath,
    args: [
      path.join(environment.appData, "npm", "node_modules", "npm", "bin", "npx-cli.js")
        .replaceAll("\\", "/"),
      "-y",
      BROWSER_RUNTIME_PACKAGE,
      ...args
    ]
  };
}

export class BrowserProvider implements Provider {
  readonly id = "browser";
  readonly capabilities = {
    consult: true,
    toolUse: false,
    images: false,
    continuation: true,
    structuredUsage: false,
    supportedPlatforms: ["darwin", "linux", "win32"] as const
  };
  private readonly options: BrowserProviderOptions;
  private readonly runner: CommandRunner;

  constructor(options: BrowserProviderOptions = {}) {
    this.options = options;
    this.runner = options.runner ?? runCommand;
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-browser-"));
    const outputPath = path.join(temporaryDirectory, "output.md");
    const runtimeArgs = [
      "--engine",
      "browser",
      "--no-background",
      "--model",
      request.model,
      "--write-output",
      outputPath,
      "-p",
      "-"
    ];

    const add = (flag: string, value?: string): void => {
      if (value !== undefined && value !== "") runtimeArgs.push(flag, value);
    };
    const usesRemoteService = Boolean(this.options.remoteHost);
    add("--browser-auto-reattach-delay", this.options.autoReattachDelay);
    add("--browser-auto-reattach-interval", this.options.autoReattachInterval);
    add("--browser-auto-reattach-timeout", this.options.autoReattachTimeout);
    add("--browser-timeout", this.options.browserTimeout);
    add("--browser-input-timeout", this.options.browserInputTimeout);
    add("--browser-attachment-timeout", this.options.attachmentTimeout);
    add("--browser-recheck-delay", this.options.recheckDelay);
    add("--browser-recheck-timeout", this.options.recheckTimeout);
    if (!usesRemoteService) add("--remote-chrome", this.options.remoteChrome);
    add("--remote-host", this.options.remoteHost);
    add("--chatgpt-url", this.options.chatgptUrl);
    add("--browser-model-strategy", this.options.modelStrategy);
    add("--browser-tab", this.options.tab);
    add("--browser-thinking-time", this.options.thinkingTime);
    add("--browser-research", this.options.research);
    add("--browser-archive", this.options.archive);
    add("--browser-attachments", this.options.attachments);
    add("--browser-bundle-format", this.options.bundleFormat);
    if (!usesRemoteService) add("--browser-port", this.options.port);
    add("--heartbeat", this.options.heartbeat);
    add("--browser-reuse-wait", this.options.reuseWait);
    add("--browser-profile-lock-timeout", this.options.profileLockTimeout);
    add("--browser-max-concurrent-tabs", this.options.maxConcurrentTabs);
    for (const followUp of this.options.followUps ?? []) {
      add("--browser-follow-up", followUp);
    }
    if (request.previousResponseId) add("--followup", request.previousResponseId);
    if (!usesRemoteService && this.options.manualLogin) {
      runtimeArgs.push("--browser-manual-login");
    }
    if (!usesRemoteService && this.options.keepBrowser) {
      runtimeArgs.push("--browser-keep-browser");
    }
    if (!usesRemoteService && this.options.attachRunning) {
      runtimeArgs.push("--browser-attach-running");
    }
    if (this.options.bundleFiles) runtimeArgs.push("--browser-bundle-files");
    if (!usesRemoteService && this.options.hideWindow) {
      runtimeArgs.push("--browser-hide-window");
    }

    const invocation = resolveBrowserRuntimeInvocation(runtimeArgs, {
      platform: process.platform,
      execPath: process.execPath,
      appData: process.env.APPDATA
    });
    const input = `${request.systemPrompt}\n\n${request.userPrompt}`;

    try {
      const result = await this.runner(invocation.command, invocation.args, {
        cwd: request.cwd,
        input,
        env: this.options.remoteToken
          ? { ORACLE_REMOTE_TOKEN: this.options.remoteToken }
          : undefined
      });
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() ||
            result.stdout.trim() ||
            `Browser runtime exited with code ${result.exitCode}.`
        );
      }
      const text = await fs.readFile(outputPath, "utf8");
      if (!text.trim()) throw new Error("Browser runtime returned an empty response.");
      const upstreamSessionId = /^Session:\s*(\S+)/m.exec(result.stdout)?.[1];
      return {
        responseId: upstreamSessionId,
        text: text.trim(),
        usage: {}
      };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async healthCheck() {
    const endpoint =
      this.options.remoteHost ??
      process.env.ORACLE_REMOTE_HOST ??
      this.options.remoteChrome;
    return [
      { name: "browser runtime", ok: true, detail: `${BROWSER_RUNTIME_PACKAGE} (resolved through npx on first use)` },
      { name: "browser route", ok: true, detail: endpoint ? `configured endpoint ${endpoint}` : "local Chrome/Chromium" }
    ];
  }
}
