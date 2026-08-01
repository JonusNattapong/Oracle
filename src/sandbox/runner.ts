import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

export type SandboxMode = "none" | "docker";
export type SandboxNetwork = "none";

export interface SandboxPolicy {
  mode: SandboxMode;
  image: string;
  network: SandboxNetwork;
  memoryMb: number;
  cpuCount: number;
  pidsLimit: number;
  environment: string[];
}

export const DEFAULT_SANDBOX_POLICY: Readonly<SandboxPolicy> = Object.freeze({
  mode: "none",
  image: "node:24-bookworm-slim",
  network: "none",
  memoryMb: 2048,
  cpuCount: 2,
  pidsLimit: 256,
  environment: []
});

export interface SandboxRunRecord {
  id: string;
  mode: SandboxMode;
  command: string;
  commandHash: string;
  workspaceRoot: string;
  network: SandboxNetwork;
  image?: string;
  exitCode: number | null;
  durationMs: number;
  killed: boolean;
  error?: string;
  createdAt: string;
}

export interface SandboxRunRecorder {
  recordSandboxRun(record: SandboxRunRecord): void | Promise<void>;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class SandboxExecutionError extends Error {
  constructor(message: string, readonly result?: Partial<SandboxRunResult>) {
    super(message);
    this.name = "SandboxExecutionError";
  }
}

export interface SandboxRunnerOptions {
  policy: SandboxPolicy;
  workspaceRoot: string;
  recorder?: SandboxRunRecorder;
  execute?: (file: string, args: string[], options: { cwd: string; timeout: number }) => Promise<SandboxRunResult>;
}

/** Keep execution evidence useful without persisting inline credentials. */
export function redactCommand(command: string): string {
  const redacted = command
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, "$1[REDACTED]")
    .replace(/((?:--?(?:token|secret|password|api[-_]?key)|(?:token|secret|password|api[-_]?key))\s*(?:=|\s)\s*)\S+/gi, "$1[REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=\S+/g, "$1=[REDACTED]");
  return redacted.length > 512 ? `${redacted.slice(0, 509)}...` : redacted;
}

/**
 * Runs shell commands either through the explicit legacy policy-only mode or
 * through a Docker container. Docker mode is deliberately fail-closed: a
 * missing daemon/image or a failed container never falls back to the host.
 */
export class SandboxRunner {
  private readonly workspaceRoot: string;

  constructor(private readonly options: SandboxRunnerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
  }

  get mode(): SandboxMode {
    return this.options.policy.mode;
  }

  async run(command: string, timeout: number): Promise<SandboxRunResult> {
    const createdAt = new Date().toISOString();
    const started = Date.now();
    const recordBase = {
      id: `sandbox-${randomUUID()}`,
      mode: this.options.policy.mode,
      command: redactCommand(command),
      commandHash: createHash("sha256").update(command).digest("hex"),
      workspaceRoot: this.workspaceRoot,
      network: this.options.policy.network,
      image: this.options.policy.mode === "docker" ? this.options.policy.image : undefined,
      createdAt
    } as const;

    try {
      const result = this.options.policy.mode === "docker"
        ? await this.runDocker(command, timeout)
        : await this.runHost(command, timeout);
      await this.options.recorder?.recordSandboxRun({
        ...recordBase,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        killed: false
      });
      return result;
    } catch (error) {
      const result = error instanceof SandboxExecutionError ? error.result : undefined;
      const durationMs = result?.durationMs ?? Date.now() - started;
      const killed = Boolean(result && result.exitCode === 124);
      await this.options.recorder?.recordSandboxRun({
        ...recordBase,
        exitCode: result?.exitCode ?? null,
        durationMs,
        killed,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async runDocker(command: string, timeout: number): Promise<SandboxRunResult> {
    const policy = this.options.policy;
    const args = [
      "run", "--rm", "--init", "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(policy.pidsLimit),
      "--memory", `${policy.memoryMb}m`,
      "--cpus", String(policy.cpuCount),
      "--network", "none",
      "--mount", `type=bind,src=${this.workspaceRoot},dst=/workspace`,
      "--workdir", "/workspace",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--env", "HOME=/tmp"
    ];
    for (const name of policy.environment) {
      const value = process.env[name];
      if (value !== undefined) args.push("--env", `${name}=${value}`);
    }
    args.push(policy.image, "sh", "-lc", command);
    return this.execute("docker", args, timeout);
  }

  private async runHost(command: string, timeout: number): Promise<SandboxRunResult> {
    const shell = process.env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "sh");
    const args = process.platform === "win32" && shell.toLowerCase().includes("powershell")
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-lc", command];
    return this.execute(shell, args, timeout);
  }

  private async execute(file: string, args: string[], timeout: number): Promise<SandboxRunResult> {
    if (this.options.execute) return this.options.execute(file, args, { cwd: this.workspaceRoot, timeout });
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(file, args, {
        cwd: this.workspaceRoot,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 1000);
        } catch {
          // Process may already be dead; no-op
        }
      }, timeout);
      const onStdout = (chunk: Buffer) => { stdout += chunk.toString(); };
      const onStderr = (chunk: Buffer) => { stderr += chunk.toString(); };
      const onError = (error: Error) => {
        clearTimeout(timer);
        cleanup();
        reject(new SandboxExecutionError(`Sandbox runner could not start '${file}': ${error.message}`, {
          stdout, stderr, durationMs: Date.now() - started
        }));
      };
      const onClose = (code: number | null) => {
        clearTimeout(timer);
        cleanup();
        const result = { stdout, stderr, exitCode: timedOut ? 124 : (code ?? 1), durationMs: Date.now() - started };
        if (timedOut) {
          reject(new SandboxExecutionError(`Command timed out after ${timeout}ms`, result));
        } else if (code !== 0) {
          reject(new SandboxExecutionError(stderr || stdout || `Command exited with code ${code}`, result));
        } else {
          resolve(result);
        }
      };
      const cleanup = () => {
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
      };
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
    });
  }
}
