import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { ChatGptBrowserConfig, ChromeProcessInfo, ChromeTarget } from "./types.js";
import { runCommand } from "../../providers/codex.js";

export async function findChromeExecutable(): Promise<string | null> {
  if (process.platform === "darwin") {
    const candidate = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";

    const candidates = [
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        await fs.access(candidate, fs.constants.F_OK);
        return candidate;
      } catch {
        // continue
      }
    }
    return null;
  }

  // Linux / Other POSIX
  const candidates = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const candidate of candidates) {
    try {
      const res = await runCommand("which", [candidate], {});
      if (res.exitCode === 0 && res.stdout.trim()) {
        return res.stdout.trim();
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function fetchJson<T>(
  url: string,
  timeoutMs = 2000,
  method: "GET" | "PUT" = "GET"
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { timeout: timeoutMs, method }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${method} ${url} returned ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP ${method} ${url} timed out`));
    });
    req.end();
  });
}

export async function getWebSocketDebuggerUrl(port: number, timeoutMs = 10000): Promise<string> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await fetchJson<{ webSocketDebuggerUrl?: string }>(url, 1500);
      if (info.webSocketDebuggerUrl) {
        return info.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome might still be starting up
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome CDP endpoint at http://127.0.0.1:${port}/json/version not reachable within ${timeoutMs}ms`);
}

/**
 * How long a Chrome already running on this profile is given to answer before
 * it is treated as gone. Generous on purpose: mistaking a busy browser for a
 * dead one starts a second instance on the same profile, which is far more
 * expensive than waiting.
 */
const REUSE_PROBE_TIMEOUT_MS = 10_000;

/**
 * How long a launch lock is honored before it is treated as abandoned (its
 * holder crashed without releasing it) rather than genuinely in progress. Set
 * above the slowest legitimate hold: a cold Chrome start can spend the 10s
 * reuse probe deciding to launch, plus up to 15s in `waitForActiveEndpoint`,
 * plus the `getWebSocketDebuggerUrl` call after that.
 */
const LAUNCH_LOCK_STALE_MS = 60_000;

/** How long a waiting caller blocks for the launch lock before giving up. */
const LAUNCH_LOCK_ACQUIRE_TIMEOUT_MS = 45_000;

/**
 * Exclusive-create-with-stale-detection lock, scoped to one file inside a
 * Chrome profile directory. Same pattern as `AuditLogger.withLock` in
 * `src/observability/audit.ts`; parameterized here because this module needs
 * two independent locks over the same profile directory (see below) with
 * different filenames and hold-time budgets — reusing one lock file for both
 * would deadlock a caller against itself.
 */
async function withFileLock<T>(
  lockPath: string,
  staleMs: number,
  acquireTimeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + acquireTimeoutMs;
  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows may report EPERM instead of EEXIST for an existing file.
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the lock at ${lockPath}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Serializes `ChromeLauncher.launch()` per profile directory across processes.
 *
 * `launch()`'s reuse check is read-then-act: read `DevToolsActivePort`, probe
 * whether it answers, and if not, delete the marker and spawn a new Chrome.
 * That is not atomic. Two processes evaluating it at the same moment — three
 * users each running `oracle ask` at once, or several `/v1/consult` requests
 * arriving together — can both conclude "no live Chrome" and both spawn one
 * onto the same profile directory. Two Chrome instances then race to own
 * `DevToolsActivePort`, and whichever wrote last decides where every later CDP
 * call in the process that lost the race gets sent — often to a Chrome that
 * has since exited, which is what an unexplained CDP hang usually was.
 *
 * A lock only around the spawn call is not enough: the decision to spawn must
 * itself happen inside the lock, or two holders in sequence could each still
 * make that decision independently before either one launches.
 *
 * This alone does not make concurrent requests safe — see `withConsultLock`
 * in backend.ts for the tab-sharing race this one does not cover.
 *
 * Exported for chrome.test.ts, which verifies the serialization and
 * stale-recovery behavior directly rather than through a real Chrome launch.
 */
export function withLaunchLock<T>(profileDir: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(
    path.join(profileDir, ".launch.lock"),
    LAUNCH_LOCK_STALE_MS,
    LAUNCH_LOCK_ACQUIRE_TIMEOUT_MS,
    operation
  );
}

/**
 * Locks the full duration of one browser-backend request — launch through
 * final read — per profile directory. `findOrCreatePageTarget` reuses
 * whichever chatgpt.com tab is already open rather than creating a new one:
 * that is the intended behavior for one user across turns (continuity), but
 * it means two requests running at once drive the *same* tab — one typing
 * while the other reads, both against a single response stream. The failure
 * mode is not a hang: each caller sees a plausible-looking answer that may
 * belong to the other caller's question, or to whatever was already on
 * screen, which is worse than a crash because nothing signals it happened.
 *
 * Held for the whole request rather than added inside `run()`'s retry loop:
 * a retry after a transient failure must not let a second caller's request
 * interleave into the same tab in the gap between attempts.
 *
 * Exported for backend.test.ts.
 */
export function withConsultLock<T>(profileDir: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(
    path.join(profileDir, ".consult.lock"),
    CONSULT_LOCK_STALE_MS,
    CONSULT_LOCK_ACQUIRE_TIMEOUT_MS,
    operation
  );
}

/**
 * A consult can legitimately run for the configured browser timeout (deep
 * research turns run to 30+ minutes; see `COMPOSER_TOOL_MIN_TIMEOUT_MS` in
 * types.ts) plus its own retry-with-backoff attempts. Set well above that so
 * a slow-but-alive holder is never mistaken for a crashed one.
 */
const CONSULT_LOCK_STALE_MS = 40 * 60_000;

/**
 * How long a queued caller waits for the tab before giving up rather than
 * queuing indefinitely behind other users' requests.
 */
const CONSULT_LOCK_ACQUIRE_TIMEOUT_MS = 40 * 60_000;

interface ActiveDevToolsEndpoint {
  port: number;
  browserPath: string;
}

async function readActiveEndpoint(profileDir: string): Promise<ActiveDevToolsEndpoint | null> {
  try {
    const content = await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
    const [portText, browserPath] = content.split(/\r?\n/);
    const port = Number.parseInt(portText, 10);
    return Number.isInteger(port)
      && port > 0
      && port <= 65535
      && /^\/devtools\/browser\/[a-z0-9-]+$/i.test(browserPath ?? "")
      ? { port, browserPath }
      : null;
  } catch {
    return null;
  }
}

async function waitForActiveEndpoint(
  profileDir: string,
  timeoutMs = 15_000
): Promise<ActiveDevToolsEndpoint> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const endpoint = await readActiveEndpoint(profileDir);
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome did not publish DevToolsActivePort in ${profileDir}.`);
}

export async function findOrCreatePageTarget(port: number): Promise<ChromeTarget> {
  const targets = await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${port}/json/list`);
  const pageTarget = targets.find(
    (target) => target.type === "page" && /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/i.test(target.url)
  );
  if (pageTarget?.webSocketDebuggerUrl) {
    return pageTarget;
  }
  // Chrome's DevTools HTTP API requires PUT for target creation.
  const targetUrl = encodeURIComponent("https://chatgpt.com");
  const newTarget = await fetchJson<ChromeTarget>(
    `http://127.0.0.1:${port}/json/new?${targetUrl}`,
    5000,
    "PUT"
  );
  return newTarget;
}

/**
 * Restores the target's window if it is minimized, so its renderer is not frozen
 * when page-domain CDP commands are issued.
 *
 * The launch flags above prevent the freeze for instances Oracle starts, but a
 * Chrome left running from `oracle browser login`, an earlier version, or a
 * manual launch has no such protection, and the launcher reuses it. Runs against
 * the browser endpoint, which keeps answering even while renderers are frozen.
 *
 * Best-effort: a failure here is reported by the caller's own command timeout,
 * so it must not mask the real work.
 */
export async function ensureWindowNotMinimized(
  port: number,
  targetId: string,
  connectSession: (wsUrl: string) => Promise<{
    send: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
    close: () => void;
  }>
): Promise<"restored" | "already-visible" | "unknown"> {
  let session: Awaited<ReturnType<typeof connectSession>> | undefined;
  try {
    const version = await fetchJson<{ webSocketDebuggerUrl: string }>(
      `http://127.0.0.1:${port}/json/version`,
      5000
    );
    session = await connectSession(version.webSocketDebuggerUrl);
    const window = await session.send<{
      windowId: number;
      bounds: { windowState?: string };
    }>("Browser.getWindowForTarget", { targetId }, 5000);
    if (window.bounds.windowState !== "minimized") return "already-visible";
    await session.send(
      "Browser.setWindowBounds",
      { windowId: window.windowId, bounds: { windowState: "normal" } },
      5000
    );
    return "restored";
  } catch {
    return "unknown";
  } finally {
    session?.close();
  }
}

export class ChromeLauncher {
  private childProcess?: ChildProcess;

  /**
   * Locked per profile directory: see `withLaunchLock` for why the reuse
   * decision below must not run concurrently with another process's.
   */
  async launch(config: ChatGptBrowserConfig): Promise<ChromeProcessInfo> {
    return withLaunchLock(config.profileDir, () => this.launchLocked(config));
  }

  private async launchLocked(config: ChatGptBrowserConfig): Promise<ChromeProcessInfo> {
    const activeEndpoint = await readActiveEndpoint(config.profileDir);

    // Reuse only when both the random port and browser UUID match the endpoint
    // Chrome published inside this exact profile.
    //
    // The probe is given room to answer slowly. A running Chrome that is busy —
    // rendering a heavy conversation, or competing for a loaded machine — can
    // miss a short deadline while being perfectly alive, and the cost of that
    // mistake is not a retry: the code below deletes DevToolsActivePort and
    // starts a second Chrome on the same profile directory. Two instances then
    // share one profile, the surviving marker points at whichever wrote last,
    // and every later CDP call may land on the wrong one and hang. A slow answer
    // must not be read as a dead browser.
    if (activeEndpoint) {
      try {
        const wsUrl = await getWebSocketDebuggerUrl(activeEndpoint.port, REUSE_PROBE_TIMEOUT_MS);
        if (new URL(wsUrl).pathname === activeEndpoint.browserPath) {
          return { port: activeEndpoint.port, webSocketDebuggerUrl: wsUrl };
        }
      } catch {
        // The profile marker may be stale; launch a fresh instance below.
      }
    }

    const chromePath = await findChromeExecutable();
    if (!chromePath) {
      throw new Error("Google Chrome executable not found. Please install Google Chrome.");
    }

    await fs.mkdir(config.profileDir, { recursive: true });
    await fs.rm(path.join(config.profileDir, "DevToolsActivePort"), { force: true });

    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${config.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Oracle's Chrome window is an automation surface nobody interacts with,
      // so it spends its life minimized or fully covered. Chrome freezes the
      // renderers of backgrounded and occluded windows, and a frozen renderer
      // never processes page-domain CDP commands: the browser endpoint keeps
      // answering while every Runtime.evaluate and Page.enable times out, which
      // surfaces as an unexplained "CDP command timed out".
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion"
    ];

    if (!config.headed) {
      args.push("--headless=new");
    }

    this.childProcess = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore"
    });
    this.childProcess.unref();

    try {
      const launchedEndpoint = await waitForActiveEndpoint(config.profileDir);
      const wsUrl = await getWebSocketDebuggerUrl(launchedEndpoint.port, 15000);
      if (new URL(wsUrl).pathname !== launchedEndpoint.browserPath) {
        throw new Error("Chrome DevTools endpoint did not match the isolated Oracle profile.");
      }
      return {
        port: launchedEndpoint.port,
        pid: this.childProcess.pid,
        webSocketDebuggerUrl: wsUrl
      };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill("SIGTERM");
    }
  }
}

export async function openChatGptInOracleChrome(
  config: ChatGptBrowserConfig
): Promise<ChromeProcessInfo> {
  const launcher = new ChromeLauncher();
  const info = await launcher.launch({ ...config, headed: true });
  await findOrCreatePageTarget(info.port);
  return info;
}

/**
 * Close only the Chrome instance whose debugger UUID was published by this
 * exact Oracle profile. Returns false when no verified instance is running.
 */
export async function closeActiveOracleChrome(profileDir: string): Promise<boolean> {
  const activeEndpoint = await readActiveEndpoint(profileDir);
  if (!activeEndpoint) return false;

  let wsUrl: string;
  try {
    wsUrl = await getWebSocketDebuggerUrl(activeEndpoint.port, 1_500);
    if (new URL(wsUrl).pathname !== activeEndpoint.browserPath) return false;
  } catch {
    return false;
  }

  const { CdpSession } = await import("./response.js");
  const session = new CdpSession(wsUrl);
  await session.connect();
  try {
    await session.send("Browser.close", {}, 5_000);
  } catch {
    // Browser.close commonly tears down the socket before returning its reply.
  } finally {
    session.close();
  }

  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      await getWebSocketDebuggerUrl(activeEndpoint.port, 500);
    } catch {
      await fs.rm(path.join(profileDir, "DevToolsActivePort"), { force: true });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Oracle Chrome did not close within 10 seconds.");
}

/**
 * Open the isolated profile without CDP flags. This avoids automated-browser
 * detection during manual OAuth/login. The user must close this window before
 * Browser Mode can reopen the profile with automation enabled.
 */
export async function openChatGptForManualLogin(
  config: ChatGptBrowserConfig
): Promise<{ pid?: number }> {
  await closeActiveOracleChrome(config.profileDir);

  const chromePath = await findChromeExecutable();
  if (!chromePath) {
    throw new Error("Google Chrome executable not found. Please install Google Chrome.");
  }
  await fs.mkdir(config.profileDir, { recursive: true });
  await fs.rm(path.join(config.profileDir, "DevToolsActivePort"), { force: true });

  const child = spawn(chromePath, [
    `--user-data-dir=${config.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://chatgpt.com"
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return { pid: child.pid };
}
