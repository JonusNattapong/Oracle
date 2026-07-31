import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OracleError } from "../errors.js";

/**
 * A bridge connection artifact describes how a client reaches a browser
 * service running on another machine. It is written by `oracle bridge host`
 * and consumed by `oracle bridge client` and `oracle bridge doctor`.
 */
export const BRIDGE_CONNECTION_VERSION = 1;

/** Artifacts older than this are reported as stale by the doctor. */
export const BRIDGE_CONNECTION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface BridgeSshTarget {
  /** `user@host` or a bare host, as understood by ssh(1). */
  target: string;
  port?: number;
  identityFile?: string;
}

export interface BridgeConnection {
  version: number;
  createdAt: string;
  /** Address the service binds on the host machine, as seen from that machine. */
  host: string;
  port: number;
  token?: string;
  ssh?: BridgeSshTarget;
}

/**
 * ssh(1) takes its target and identity path as positional/option values. A
 * value starting with `-` would be parsed as an option, so every argument that
 * reaches the ssh command line is restricted to characters that cannot smuggle
 * one in — and, because `-` is a legal character mid-word, the first character
 * of each word is restricted further.
 */
const HOST_WORD = "[A-Za-z0-9._][A-Za-z0-9._-]*";
const SSH_TARGET_PATTERN = new RegExp(`^${HOST_WORD}(@${HOST_WORD})?$`);
const HOST_PATTERN = new RegExp(`^${HOST_WORD}$`);

const sshSchema = z
  .object({
    target: z.string().trim().regex(SSH_TARGET_PATTERN),
    port: z.number().int().min(1).max(65_535).optional(),
    identityFile: z.string().trim().min(1).optional()
  })
  .strict();

const connectionSchema = z
  .object({
    version: z.number().int().positive(),
    createdAt: z.string().trim().min(1),
    host: z.string().trim().regex(HOST_PATTERN),
    port: z.number().int().min(1).max(65_535),
    token: z.string().trim().min(1).optional(),
    ssh: sshSchema.optional()
  })
  .strict();

function invalid(reason: string, details?: Record<string, unknown>): OracleError {
  return new OracleError(
    "ORACLE_BRIDGE_INVALID",
    `The bridge connection artifact is invalid: ${reason}`,
    "Regenerate it with `oracle bridge host --out <path>` on the machine running Chrome.",
    details
  );
}

export function parseBridgeConnection(raw: unknown): BridgeConnection {
  const parsed = connectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  if (parsed.data.version !== BRIDGE_CONNECTION_VERSION) {
    throw invalid(
      `unsupported version ${parsed.data.version}, expected ${BRIDGE_CONNECTION_VERSION}`,
      { version: parsed.data.version }
    );
  }
  if (parsed.data.ssh?.identityFile?.startsWith("-")) {
    throw invalid("the ssh identity file may not start with '-'");
  }
  if (Number.isNaN(Date.parse(parsed.data.createdAt))) {
    throw invalid("createdAt is not a valid timestamp");
  }
  return parsed.data;
}

export interface CreateBridgeConnectionInput {
  host: string;
  port: number;
  token?: string;
  ssh?: BridgeSshTarget;
  now?: Date;
}

export function createBridgeConnection(
  input: CreateBridgeConnectionInput
): BridgeConnection {
  return parseBridgeConnection({
    version: BRIDGE_CONNECTION_VERSION,
    createdAt: (input.now ?? new Date()).toISOString(),
    host: input.host,
    port: input.port,
    ...(input.token ? { token: input.token } : {}),
    ...(input.ssh ? { ssh: input.ssh } : {})
  });
}

export function generateBridgeToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function serializeBridgeConnection(connection: BridgeConnection): string {
  return `${JSON.stringify(connection, null, 2)}\n`;
}

/** A copy safe to print or log: the token never survives. */
export function redactBridgeConnection(connection: BridgeConnection): BridgeConnection {
  const { token, ...rest } = connection;
  return token ? { ...rest, token: "<redacted>" } : { ...rest };
}

export function bridgeConnectionPath(cwd: string, override?: string): string {
  if (override) return path.resolve(cwd, override);
  return path.join(path.resolve(cwd), ".oracle", "bridge.json");
}

export async function writeBridgeConnection(
  filePath: string,
  connection: BridgeConnection
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, serializeBridgeConnection(connection), {
    encoding: "utf8",
    mode: 0o600
  });
  // writeFile's mode applies only when creating; chmod covers a reused temp.
  await fs.chmod(temporary, 0o600).catch(() => {});
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function readBridgeConnection(filePath: string): Promise<BridgeConnection> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OracleError(
        "ORACLE_BRIDGE_UNAVAILABLE",
        `No bridge connection artifact at ${filePath}.`,
        "Run `oracle bridge host` on the machine with the signed-in browser, then copy the artifact here.",
        { filePath }
      );
    }
    throw error;
  }
  try {
    return parseBridgeConnection(JSON.parse(raw));
  } catch (error) {
    if (error instanceof OracleError) throw error;
    throw invalid("the file is not valid JSON", { filePath });
  }
}

export function bridgeConnectionAgeMs(
  connection: BridgeConnection,
  now: Date = new Date()
): number {
  return now.getTime() - Date.parse(connection.createdAt);
}
