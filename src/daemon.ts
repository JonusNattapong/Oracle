#!/usr/bin/env node
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { OracleDaemon } from "./runtime/daemon.js";

const homeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
const host = process.env.ORACLE_RUNTIME_HOST ?? "127.0.0.1";
const port = Number(process.env.ORACLE_RUNTIME_PORT ?? "4777");
const workspaceRoot = process.env.ORACLE_WORKSPACE_ROOT ?? process.cwd();

let exiting = false;
const daemon = new OracleDaemon({
  homeDir,
  host,
  port,
  workspaceRoot,
  allowRemote: process.env.ORACLE_RUNTIME_REMOTE === "1",
  onShutdown: () => {
    if (!exiting) process.exit(0);
  }
});

const shutdown = async (signal: string) => {
  if (exiting) return;
  exiting = true;
  console.error(`[oracle-daemon] ${signal}; shutting down`);
  await daemon.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const state = await daemon.start();
  console.error(`[oracle-daemon] listening on http://${state.host}:${state.port} (pid ${state.pid})`);
  await new Promise(() => {});
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
