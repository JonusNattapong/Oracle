import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

function debugOrchestrator(message: string): void {
  if (process.env.ORACLE_DEBUG) console.debug(message);
}

export interface ProcessInfo {
  pid: number;
  port: number;
  endpoint: string;
}

/**
 * ProcessSupervisor manages the lifecycle of oracle-memory as a background
 * daemon process. The process:
 * - Is spawned once and left running (not killed per CLI invocation)
 * - Exits via idle-timeout (10 min default, set via env var in the process)
 * - Stores pid/port in ~/.oracle/run/<service>.{pid,port} lockfiles
 * - Health-checked before trust via a lightweight ping call
 */
export class ProcessSupervisor {
  private readonly runDir: string;
  private activeProcesses = new Map<string, { process: ChildProcess; startTime: number }>();

  constructor(homeDir: string = path.join(os.homedir(), ".oracle")) {
    this.runDir = path.join(homeDir, "run");
  }

  /**
   * ensureRunning checks if a service process is already running (and healthy),
   * or spawns a new one if needed. Returns the endpoint (URL) or null if fallback is required.
   */
  async ensureRunning(
    service: "memory"
  ): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const existing = await this.readLockFile(service);

    if (existing) {
      // Health-check the existing process
      const isHealthy = await this.healthCheck(service, existing.endpoint);
      if (isHealthy) {
        return existing;
      }
      // Stale pid/port — clean it up and try to spawn new
      await this.removeLockFile(service);
    }

    // No existing process or it's dead — spawn new one, guarded by a
    // cross-process lock so two `oracle` invocations racing at once don't
    // both allocate a port and spawn duplicate daemons.
    return this.spawnServiceExclusive(service);
  }

  private async spawnServiceExclusive(
    service: "memory"
  ): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const lockPath = path.join(this.runDir, `${service}.spawn.lock`);
    await fs.mkdir(this.runDir, { recursive: true });

    let handle: fs.FileHandle;
    try {
      // "wx" = exclusive create, fails if the file already exists — the
      // atomic primitive that makes this a real cross-process mutex.
      handle = await fs.open(lockPath, "wx");
    } catch {
      // Another process is already spawning. Wait for it to finish (or the
      // lock to go stale) and adopt whatever it ends up writing.
      return this.waitForSibling(service, lockPath);
    }

    try {
      await handle.close();
      // Re-check: a sibling may have finished spawning between our initial
      // readLockFile() and acquiring this lock.
      const existing = await this.readLockFile(service);
      if (existing && (await this.healthCheck(service, existing.endpoint))) {
        return existing;
      }
      return await this.spawnService(service);
    } finally {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }

  private async waitForSibling(
    service: "memory",
    lockPath: string
  ): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const STALE_MS = 5_000;
    for (let waited = 0; waited < 3_000; waited += 200) {
      await sleep(200);
      const existing = await this.readLockFile(service);
      if (existing && (await this.healthCheck(service, existing.endpoint))) {
        return existing;
      }
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          return this.spawnServiceExclusive(service);
        }
      } catch {
        // Lock file gone but no healthy lockfile appeared yet
      }
    }
    return null;
  }

  private async readLockFile(
    service: "memory"
  ): Promise<{ endpoint: string; pid: number; port: number } | null> {
    try {
      const pidFile = path.join(this.runDir, `${service}.pid`);
      const portFile = path.join(this.runDir, `${service}.port`);

      const pid = parseInt(await fs.readFile(pidFile, "utf8"), 10);
      const port = parseInt(await fs.readFile(portFile, "utf8"), 10);

      if (!pid || !port || isNaN(pid) || isNaN(port)) return null;

      return {
        pid,
        port,
        endpoint: `http://127.0.0.1:${port}/mcp`,
      };
    } catch {
      return null;
    }
  }

  private async writeLockFile(service: "memory", pid: number, port: number): Promise<void> {
    await fs.mkdir(this.runDir, { recursive: true });
    const pidFile = path.join(this.runDir, `${service}.pid`);
    const portFile = path.join(this.runDir, `${service}.port`);

    // Write atomically via temp file
    const pidTmp = `${pidFile}.tmp`;
    const portTmp = `${portFile}.tmp`;
    await fs.writeFile(pidTmp, String(pid), "utf8");
    await fs.rename(pidTmp, pidFile);
    await fs.writeFile(portTmp, String(port), "utf8");
    await fs.rename(portTmp, portFile);
  }

  private async removeLockFile(service: "memory"): Promise<void> {
    try {
      await fs.unlink(path.join(this.runDir, `${service}.pid`));
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(path.join(this.runDir, `${service}.port`));
    } catch {
      /* ignore */
    }
  }

  private async healthCheck(service: "memory", endpoint: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 1000);

      const url = `${endpoint.replace("/mcp", "")}/health`;

      const resp = await fetch(url, {
        method: "GET",
        signal: controller.signal as AbortSignal,
      });

      clearTimeout(timeoutHandle);
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async findFreePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  private async spawnService(service: "memory"): Promise<{ endpoint: string; pid: number; port: number } | null> {
    const port = await this.findFreePort();
    const command = process.env.ORACLE_MEMORY_BIN || "oracle-memory";

    // Resolve how to launch cross-platform (.js entry scripts vs Windows .cmd/.ps1 shims).
    const lower = command.toLowerCase();
    let execCommand = command;
    let execArgs: string[] = [];
    let useShell = false;
    if (/\.(js|mjs|cjs)$/.test(lower)) {
      execCommand = process.execPath;
      execArgs = [command];
    } else if (/\.(cmd|bat|ps1)$/.test(lower)) {
      useShell = true;
    }

    try {
      let spawnError: Error | null = null;
      let exited = false;

      const proc = spawn(execCommand, execArgs, {
        detached: true,
        stdio: "ignore",
        shell: useShell,
        env: {
          ...process.env,
          ORACLE_MEMORY_PORT: String(port),
          ORACLE_MEMORY_TRANSPORT: "http",
        },
      });

      proc.on("error", (err) => {
        spawnError = err;
      });
      proc.on("exit", () => {
        exited = true;
      });

      const pid = proc.pid;
      if (!pid) throw new Error("Failed to get process ID");

      proc.unref();
      this.activeProcesses.set(service, { process: proc, startTime: Date.now() });

      // Poll health check with fast fallback if process errors or exits early.
      const endpoint = `http://127.0.0.1:${port}/mcp`;
      let retries = 25;
      while (retries > 0) {
        await sleep(150);
        if (spawnError || exited || proc.exitCode !== null) {
          debugOrchestrator(`[orchestrator] ${service} failed or exited early — falling back immediately`);
          return null;
        }
        if (await this.healthCheck(service, endpoint)) {
          await this.writeLockFile(service, pid, port);
          return { endpoint, pid, port };
        }
        retries--;
      }

      return null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Expected, designed condition: the sidecar binary may simply not be
      // installed, in which case the caller (factory) transparently falls back
      // to the file adapter. Keep this at debug level so it matches the
      // factory's fallback logging instead of surfacing a scary error line
      // (on Windows/PowerShell a bare console.error renders as a
      // NativeCommandError). The null return is the real signal.
      debugOrchestrator(`[orchestrator] failed to spawn ${service}: ${reason}`);
      return null;
    }
  }

  /**
   * Gracefully shutdown a managed process (if we spawned it).
   * In practice, this is rarely needed since the daemon self-exits on idle timeout.
   */
  async shutdown(service: "memory"): Promise<void> {
    const proc = this.activeProcesses.get(service);
    if (proc) {
      try {
        proc.process.kill("SIGTERM");
        await sleep(1000);
        if (!proc.process.killed) {
          proc.process.kill("SIGKILL");
        }
      } catch {
        /* ignore */
      }
      this.activeProcesses.delete(service);
    }
    await this.removeLockFile(service);
  }
}
