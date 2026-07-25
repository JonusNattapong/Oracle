import { execFile, exec } from "node:child_process";
import os from "node:os";

/**
 * Command isolation for the agent's `bash` tool.
 *
 * Prior to this the only limits were a timeout and an output cap: a command
 * could still fork-bomb the host, exfiltrate over the network, or fill the
 * disk. This adds real containment where the platform supports it, and is
 * explicit about degrading to `none` where it does not.
 */

export type SandboxMode = "docker" | "namespace" | "none";

export interface SandboxLimits {
  /** Wall-clock ceiling; the process is killed past it. */
  timeoutMs: number;
  /** Memory ceiling in megabytes. */
  memoryMB: number;
  /** CPU share, as a fraction of one core. */
  cpus: number;
  /** Max processes/threads, the fork-bomb ceiling. */
  maxProcesses: number;
  /** Allow outbound network access. Off by default. */
  allowNetwork: boolean;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 60_000,
  memoryMB: 512,
  cpus: 0.5,
  maxProcesses: 128,
  allowNetwork: false,
};

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  mode: SandboxMode;
  durationMs: number;
  killed: boolean;
}

export interface SandboxOptions {
  cwd: string;
  mode?: SandboxMode;
  limits?: Partial<SandboxLimits>;
  /** Image used for `docker` mode. */
  image?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_IMAGE = process.env.ORACLE_SANDBOX_IMAGE ?? "alpine:3.20";
const MAX_BUFFER = 10 * 1024 * 1024;

let dockerAvailable: boolean | null = null;
let namespaceAvailable: boolean | null = null;

/** Reset cached capability probes. For tests. */
export function resetSandboxProbes(): void {
  dockerAvailable = null;
  namespaceAvailable = null;
}

function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: MAX_BUFFER, env: opts.env },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
          killed: Boolean(e?.killed),
        });
      }
    );
  });
}

/** Is a working Docker daemon reachable? Probed once per process. */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  // `docker info` (not `--version`) because the CLI can exist with no daemon.
  const result = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
  dockerAvailable = result.code === 0;
  return dockerAvailable;
}

/** Can we build unprivileged namespaces via unshare(1)? Linux only. */
export async function isNamespaceAvailable(): Promise<boolean> {
  if (namespaceAvailable !== null) return namespaceAvailable;
  if (os.platform() !== "linux") {
    namespaceAvailable = false;
    return false;
  }
  const result = await run("unshare", ["--user", "--pid", "--fork", "true"], { timeout: 5000 });
  namespaceAvailable = result.code === 0;
  return namespaceAvailable;
}

/**
 * Pick the strongest isolation this host can actually provide.
 * Docker first (portable, strongest), then Linux namespaces, then none.
 */
export async function detectSandboxMode(): Promise<SandboxMode> {
  if (await isDockerAvailable()) return "docker";
  if (await isNamespaceAvailable()) return "namespace";
  return "none";
}

/** Build the `docker run` argv for a command. Exported for testing. */
export function buildDockerArgs(
  command: string,
  cwd: string,
  limits: SandboxLimits,
  image = DEFAULT_IMAGE
): string[] {
  return [
    "run",
    "--rm",
    "--interactive=false",
    // No network unless explicitly allowed — blocks exfiltration by default.
    "--network", limits.allowNetwork ? "bridge" : "none",
    "--memory", `${limits.memoryMB}m`,
    // Without a matching swap cap the memory limit is trivially bypassed.
    "--memory-swap", `${limits.memoryMB}m`,
    "--cpus", String(limits.cpus),
    // The fork-bomb ceiling.
    "--pids-limit", String(limits.maxProcesses),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    // Writable workspace, but the rest of the container filesystem is read-only.
    "--read-only",
    "--tmpfs", "/tmp:rw,size=64m,noexec",
    "--volume", `${cwd}:/workspace`,
    "--workdir", "/workspace",
    image,
    "sh", "-c", command,
  ];
}

/** Build the `unshare` argv for a command. Exported for testing. */
export function buildNamespaceArgs(command: string, limits: SandboxLimits): string[] {
  const args = ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc"];
  if (!limits.allowNetwork) args.push("--net");
  // ulimit caps processes inside the new namespace; `-u` is the fork ceiling.
  args.push("sh", "-c", `ulimit -u ${limits.maxProcesses}; ${command}`);
  return args;
}

/**
 * Execute a shell command under the requested isolation.
 *
 * `mode` defaults to auto-detection. Passing an explicit mode that the host
 * cannot provide is an error rather than a silent downgrade — a caller that
 * asked for containment should not get none without being told.
 */
export async function runSandboxed(
  command: string,
  options: SandboxOptions
): Promise<SandboxResult> {
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...options.limits };
  const mode = options.mode ?? (await detectSandboxMode());
  const started = Date.now();

  if (mode === "docker" && !(await isDockerAvailable())) {
    throw new Error("Sandbox mode 'docker' requested but no Docker daemon is reachable.");
  }
  if (mode === "namespace" && !(await isNamespaceAvailable())) {
    throw new Error(
      `Sandbox mode 'namespace' requested but unprivileged namespaces are unavailable on ${os.platform()}.`
    );
  }

  let result: { stdout: string; stderr: string; code: number; killed: boolean };

  if (mode === "docker") {
    result = await run("docker", buildDockerArgs(command, options.cwd, limits, options.image), {
      timeout: limits.timeoutMs,
      env: options.env,
    });
  } else if (mode === "namespace") {
    result = await run("unshare", buildNamespaceArgs(command, limits), {
      cwd: options.cwd,
      timeout: limits.timeoutMs,
      env: options.env,
    });
  } else {
    // Unsandboxed fallback. `command` is a shell command by contract — this is
    // the bash tool's purpose, and policy.validateCommand() is the gate
    // upstream. It is precisely this path that the modes above exist to avoid.
    result = await new Promise((resolve) => {
      exec(
        command,
        {
          cwd: options.cwd,
          timeout: limits.timeoutMs,
          maxBuffer: MAX_BUFFER,
          env: options.env,
          shell: process.env.SHELL || undefined,
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
            killed: Boolean(e?.killed),
          });
        }
      );
    });
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    mode,
    durationMs: Date.now() - started,
    killed: result.killed,
  };
}

/** One-line description of the active isolation, for `oracle doctor`. */
export function describeSandboxMode(mode: SandboxMode): string {
  switch (mode) {
    case "docker":
      return "docker — per-call container, no network, capped memory/cpu/pids";
    case "namespace":
      return "namespace — unshared pid/net namespaces with a fork ceiling";
    default:
      return "none — timeout and output cap only (no process or network isolation)";
  }
}
