import net from "node:net";
import { OracleError } from "../errors.js";
import {
  BRIDGE_CONNECTION_MAX_AGE_MS,
  bridgeConnectionAgeMs,
  readBridgeConnection,
  type BridgeConnection
} from "./connection.js";
import { DEFAULT_BRIDGE_LOCAL_PORT, buildSshTunnelCommand } from "./tunnel.js";

export interface BridgeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BridgeDoctorProbes {
  readConnection(filePath: string): Promise<BridgeConnection>;
  /** Resolves true when an ssh client is on PATH. */
  hasSsh(): Promise<boolean>;
  /** Resolves true when a TCP connection to the address succeeds. */
  probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean>;
  now(): Date;
}

export interface BridgeDoctorOptions {
  connectionPath: string;
  localPort?: number;
  /** Skip the tunnel checks and probe the service address directly. */
  direct?: boolean;
  probeTimeoutMs?: number;
}

export async function probeTcp(
  host: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function describeAge(ageMs: number): string {
  const hours = ageMs / (60 * 60 * 1_000);
  if (hours < 1) return `${Math.max(0, Math.round(ageMs / 60_000))}m old`;
  return `${hours.toFixed(1)}h old`;
}

export async function runBridgeDoctor(
  options: BridgeDoctorOptions,
  probes: Partial<BridgeDoctorProbes> = {}
): Promise<BridgeCheck[]> {
  const resolved: BridgeDoctorProbes = {
    readConnection: probes.readConnection ?? readBridgeConnection,
    hasSsh: probes.hasSsh ?? defaultHasSsh,
    probeTcp: probes.probeTcp ?? probeTcp,
    now: probes.now ?? (() => new Date())
  };
  const checks: BridgeCheck[] = [];
  const timeoutMs = options.probeTimeoutMs ?? 3_000;

  let connection: BridgeConnection;
  try {
    connection = await resolved.readConnection(options.connectionPath);
  } catch (error) {
    checks.push({
      name: "connection artifact",
      ok: false,
      detail:
        error instanceof OracleError
          ? `${error.message} ${error.suggestion}`
          : `Could not read ${options.connectionPath}.`
    });
    return checks;
  }

  checks.push({
    name: "connection artifact",
    ok: true,
    detail: `${options.connectionPath} → ${connection.host}:${connection.port}`
  });

  const ageMs = bridgeConnectionAgeMs(connection, resolved.now());
  const fresh = ageMs >= 0 && ageMs <= BRIDGE_CONNECTION_MAX_AGE_MS;
  checks.push({
    name: "freshness",
    ok: fresh,
    detail: fresh
      ? `created ${describeAge(ageMs)}`
      : ageMs < 0
        ? "createdAt is in the future; check clock skew between the two machines"
        : `created ${describeAge(ageMs)}; regenerate it with \`oracle bridge host\``
  });

  checks.push({
    name: "token",
    ok: Boolean(connection.token),
    detail: connection.token
      ? "present (set ORACLE_REMOTE_TOKEN from the artifact)"
      : "missing; the service will reject requests unless it runs without a token"
  });

  const localPort = options.localPort ?? DEFAULT_BRIDGE_LOCAL_PORT;

  if (options.direct) {
    const reachable = await resolved.probeTcp(connection.host, connection.port, timeoutMs);
    checks.push({
      name: "service reachable",
      ok: reachable,
      detail: reachable
        ? `${connection.host}:${connection.port} accepted a connection`
        : `${connection.host}:${connection.port} refused a connection`
    });
    return checks;
  }

  if (!connection.ssh) {
    checks.push({
      name: "ssh target",
      ok: false,
      detail:
        "not configured; recreate the artifact with --ssh-target, or check directly with --direct"
    });
    return checks;
  }

  checks.push({
    name: "ssh target",
    ok: true,
    detail: formatSshCheckDetail(connection, localPort)
  });

  const sshAvailable = await resolved.hasSsh();
  checks.push({
    name: "ssh client",
    ok: sshAvailable,
    detail: sshAvailable ? "found on PATH" : "not found on PATH; install an OpenSSH client"
  });

  const tunnelUp = await resolved.probeTcp("127.0.0.1", localPort, timeoutMs);
  checks.push({
    name: "tunnel",
    ok: tunnelUp,
    detail: tunnelUp
      ? `127.0.0.1:${localPort} accepted a connection`
      : `127.0.0.1:${localPort} refused a connection; start it with \`oracle bridge client\``
  });

  return checks;
}

function formatSshCheckDetail(connection: BridgeConnection, localPort: number): string {
  const invocation = buildSshTunnelCommand(connection, { localPort });
  return invocation.args[invocation.args.length - 1] ?? "";
}

async function defaultHasSsh(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return await new Promise<boolean>((resolve) => {
    const child = spawn("ssh", ["-V"], { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0 || code === 255));
  });
}
