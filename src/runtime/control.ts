import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RuntimeClient, type RuntimeHealth } from "./client.js";
import {
  isProcessAlive,
  readDaemonState,
  removeDaemonState,
  type DaemonState
} from "./state.js";

export interface DaemonStatus {
  running: boolean;
  state?: DaemonState;
  health?: RuntimeHealth;
  stale?: boolean;
}

export async function daemonStatus(homeDir: string): Promise<DaemonStatus> {
  const state = await readDaemonState(homeDir);
  if (!state) return { running: false };
  const client = await RuntimeClient.connect(homeDir);
  if (client) return { running: true, state, health: await client.health() };
  return { running: false, state, stale: !isProcessAlive(state.pid) };
}

export async function startDaemon(input: {
  homeDir: string;
  host?: string;
  port?: number;
  workspaceRoot?: string;
  allowRemote?: boolean;
  timeoutMs?: number;
}): Promise<{ state: DaemonState; alreadyRunning: boolean }> {
  const current = await daemonStatus(input.homeDir);
  if (current.running && current.state) {
    return { state: current.state, alreadyRunning: true };
  }
  if (current.state && current.stale) {
    await removeDaemonState(input.homeDir, current.state.pid);
  } else if (current.state) {
    throw new Error(
      `Daemon state exists for live pid ${current.state.pid}, but its API is unavailable. Stop that process before restarting.`
    );
  }

  const runtimeDir = path.join(input.homeDir, "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  const logPath = path.join(runtimeDir, "daemon.log");
  const logDescriptor = fsSync.openSync(logPath, "a", 0o600);
  fsSync.chmodSync(logPath, 0o600);
  const daemonEntry = fileURLToPath(new URL("../daemon.js", import.meta.url));
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
    env: {
      ...process.env,
      ORACLE_HOME_DIR: input.homeDir,
      ORACLE_RUNTIME_HOST: input.host ?? "127.0.0.1",
      ORACLE_RUNTIME_PORT: String(input.port ?? 4777),
      ORACLE_RUNTIME_REMOTE: input.allowRemote ? "1" : "0",
      ORACLE_WORKSPACE_ROOT: input.workspaceRoot ?? process.cwd()
    }
  });
  child.unref();
  fsSync.closeSync(logDescriptor);

  const deadline = Date.now() + (input.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Oracle daemon exited during startup with code ${child.exitCode}. See ${logPath}`);
    }
    const client = await RuntimeClient.connect(input.homeDir);
    if (client) return { state: client.state, alreadyRunning: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Oracle daemon did not become ready within 5 seconds. See ${logPath}`);
}

export async function stopDaemon(homeDir: string, timeoutMs = 5000): Promise<boolean> {
  const client = await RuntimeClient.connect(homeDir);
  if (!client) return false;
  await client.requestStop();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await readDaemonState(homeDir)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Oracle daemon acknowledged shutdown but did not stop within 5 seconds.");
}
