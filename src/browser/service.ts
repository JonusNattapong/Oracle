import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  resolveBrowserRuntimeInvocation
} from "../providers/browser.js";

export interface BrowserServiceOptions {
  host: string;
  port: number;
  token?: string;
  manualLogin: boolean;
  profileDir?: string;
  cwd: string;
}

export interface BrowserServiceInvocation {
  command: string;
  args: string[];
}

interface ServiceRuntimeEnvironment {
  platform: NodeJS.Platform;
  execPath: string;
  appData?: string;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export function buildBrowserServiceInvocation(
  options: BrowserServiceOptions,
  environment: ServiceRuntimeEnvironment
): BrowserServiceInvocation {
  const args = [
    "serve",
    "--host",
    options.host,
    "--port",
    String(options.port)
  ];
  if (options.token) args.push("--token", options.token);
  if (options.manualLogin) {
    args.push("--manual-login");
    if (options.profileDir) {
      args.push("--manual-login-profile-dir", options.profileDir);
    }
  }
  return resolveBrowserRuntimeInvocation(args, environment);
}

function quote(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

export function formatBrowserServiceInvocation(
  invocation: BrowserServiceInvocation
): string {
  const redacted = [...invocation.args];
  const tokenIndex = redacted.indexOf("--token");
  if (tokenIndex >= 0 && tokenIndex + 1 < redacted.length) {
    redacted[tokenIndex + 1] = "<redacted>";
  }
  return [invocation.command, ...redacted].map(quote).join(" ");
}

export async function runBrowserService(
  options: BrowserServiceOptions,
  spawnProcess: SpawnProcess = spawn
): Promise<number> {
  const invocation = buildBrowserServiceInvocation(options, {
    platform: process.platform,
    execPath: process.execPath,
    appData: process.env.APPDATA
  });
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: false
  });

  return await new Promise<number>((resolve, reject) => {
    const forwardInterrupt = (): void => {
      if (!child.killed) child.kill("SIGINT");
    };
    const forwardTerminate = (): void => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const cleanup = (): void => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    };

    process.once("SIGINT", forwardInterrupt);
    process.once("SIGTERM", forwardTerminate);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolve(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}
