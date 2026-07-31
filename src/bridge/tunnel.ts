import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { OracleError } from "../errors.js";
import type { BridgeConnection } from "./connection.js";

export const DEFAULT_BRIDGE_LOCAL_PORT = 9473;

export interface SshTunnelInvocation {
  command: string;
  args: string[];
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

function requireSsh(connection: BridgeConnection): BridgeConnection["ssh"] & object {
  if (!connection.ssh) {
    throw new OracleError(
      "ORACLE_BRIDGE_INVALID",
      "The bridge connection artifact has no ssh target.",
      "Recreate it with `oracle bridge host --ssh-target <user@host>`, or use `oracle bridge client --no-tunnel` when the service is directly reachable."
    );
  }
  return connection.ssh;
}

export function assertBridgeLocalPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new OracleError(
      "ORACLE_BRIDGE_INVALID",
      `Invalid local port ${port}.`,
      "Pass --local-port with an integer between 1 and 65535."
    );
  }
  return port;
}

/**
 * Builds the forwarding command: everything the client sends to
 * `127.0.0.1:<localPort>` surfaces on the host as `<host>:<port>`.
 *
 * The tunnel carries no credentials — the service token stays in the artifact
 * and is supplied separately through `ORACLE_REMOTE_TOKEN`.
 */
export function buildSshTunnelCommand(
  connection: BridgeConnection,
  options: { localPort?: number } = {}
): SshTunnelInvocation {
  const ssh = requireSsh(connection);
  const localPort = assertBridgeLocalPort(options.localPort ?? DEFAULT_BRIDGE_LOCAL_PORT);
  const args = [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${localPort}:${connection.host}:${connection.port}`
  ];
  if (ssh.port !== undefined) args.push("-p", String(ssh.port));
  if (ssh.identityFile) args.push("-i", ssh.identityFile);
  args.push(ssh.target);
  return { command: "ssh", args };
}

function quote(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

export function formatSshTunnelCommand(invocation: SshTunnelInvocation): string {
  return [invocation.command, ...invocation.args].map(quote).join(" ");
}

/** The `--remote-host` value the client should use once the tunnel is up. */
export function bridgeRemoteHostUrl(localPort: number = DEFAULT_BRIDGE_LOCAL_PORT): string {
  return `http://127.0.0.1:${assertBridgeLocalPort(localPort)}`;
}

export async function runSshTunnel(
  invocation: SshTunnelInvocation,
  spawnProcess: SpawnProcess = spawn
): Promise<number> {
  const child = spawnProcess(invocation.command, invocation.args, {
    env: process.env,
    stdio: "inherit",
    windowsHide: true
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
