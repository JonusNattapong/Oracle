import fs from "node:fs/promises";
import path from "node:path";
import { logSandbox } from "../observability/log.js";
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from "../sandbox/runner.js";

export interface OracleApprovalPolicy {
  mode: "off" | "risky" | "all-mutations";
  reviewers?: string[];
  highRiskQuorum?: number;
  expiryMinutes: number;
  allowTelegramHighRisk: boolean;
}

export interface OraclePolicy {
  /** Glob patterns or path substrings forbidden from being read, written, or edited by agents. */
  forbiddenGlobs: string[];
  /** Allowed command prefixes for shell execution (if set, commands must match one prefix). */
  allowedCommands?: string[];
  /** Substrings or patterns strictly forbidden in shell commands. */
  forbiddenCommands: string[];
  /** Maximum file mutations allowed in a single agent session (default: 50). */
  maxMutationsPerSession: number;
  /** Human approval settings for mutating or high-risk tools. */
  approval: OracleApprovalPolicy;
  /** Execution isolation for shell commands. `none` is policy-only and explicit. */
  sandbox: SandboxPolicy;
}

export const DEFAULT_POLICY: Readonly<OraclePolicy> = Object.freeze<OraclePolicy>({
  forbiddenGlobs: [
    ".env",
    ".env.",
    "id_rsa",
    "id_ed25519",
    ".pem",
    "credentials.json",
    ".oracle/policy.json",
  ],
  forbiddenCommands: [
    "rm -rf /",
    "rm -rf c:",
    "rm -rf c:\\",
    "mkfs",
    "dd if=",
    ":(){ :|:& };:",
  ],
  maxMutationsPerSession: 50,
  approval: {
    mode: "risky",
    expiryMinutes: 30,
    allowTelegramHighRisk: false
  },
  sandbox: { ...DEFAULT_SANDBOX_POLICY }
});

export class PolicyViolationError extends Error {
  constructor(message: string, public readonly rule: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

/**
 * Load policy configuration from `.oracle/policy.json` merged with defaults.
 */
export async function loadPolicy(workspaceRoot: string): Promise<OraclePolicy> {
  const policyFile = path.join(workspaceRoot, ".oracle", "policy.json");
  try {
    const raw = JSON.parse(await fs.readFile(policyFile, "utf8")) as
      Omit<Partial<OraclePolicy>, "approval" | "sandbox"> & {
        approval?: Partial<OracleApprovalPolicy>;
        sandbox?: Partial<SandboxPolicy>;
      };
    const rawApproval = raw.approval ?? {};
    const mode = rawApproval.mode ?? DEFAULT_POLICY.approval.mode;
    if (!["off", "risky", "all-mutations"].includes(mode)) {
      throw new Error("approval.mode must be off, risky, or all-mutations.");
    }
    const reviewers = rawApproval.reviewers?.map((reviewer) => reviewer.trim()).filter(Boolean);
    const highRiskQuorum = rawApproval.highRiskQuorum;
    if (highRiskQuorum !== undefined && (!Number.isInteger(highRiskQuorum) || highRiskQuorum < 1)) {
      throw new Error("approval.highRiskQuorum must be a positive integer.");
    }
    const expiryMinutes = rawApproval.expiryMinutes ?? DEFAULT_POLICY.approval.expiryMinutes;
    if (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0) {
      throw new Error("approval.expiryMinutes must be greater than zero.");
    }
    const sandbox = { ...DEFAULT_SANDBOX_POLICY, ...(raw.sandbox ?? {}) };
    if (!['none', 'docker'].includes(sandbox.mode)) {
      throw new Error("sandbox.mode must be none or docker.");
    }
    if (sandbox.network !== "none") {
      throw new Error("sandbox.network must be none in the current Docker sandbox.");
    }
    if (!Number.isInteger(sandbox.memoryMb) || sandbox.memoryMb < 128) {
      throw new Error("sandbox.memoryMb must be an integer of at least 128.");
    }
    if (!Number.isFinite(sandbox.cpuCount) || sandbox.cpuCount <= 0) {
      throw new Error("sandbox.cpuCount must be greater than zero.");
    }
    if (!Number.isInteger(sandbox.pidsLimit) || sandbox.pidsLimit < 16) {
      throw new Error("sandbox.pidsLimit must be an integer of at least 16.");
    }
    if (!Array.isArray(sandbox.environment) || sandbox.environment.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw new Error("sandbox.environment must contain valid environment variable names.");
    }
    return {
      forbiddenGlobs: [...DEFAULT_POLICY.forbiddenGlobs, ...(raw.forbiddenGlobs ?? [])],
      allowedCommands: raw.allowedCommands,
      forbiddenCommands: [...DEFAULT_POLICY.forbiddenCommands, ...(raw.forbiddenCommands ?? [])],
      maxMutationsPerSession: raw.maxMutationsPerSession ?? DEFAULT_POLICY.maxMutationsPerSession,
      approval: {
        mode,
        reviewers,
        highRiskQuorum,
        expiryMinutes,
        allowTelegramHighRisk: rawApproval.allowTelegramHighRisk
          ?? DEFAULT_POLICY.approval.allowTelegramHighRisk
      },
      sandbox
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ...DEFAULT_POLICY,
        approval: { ...DEFAULT_POLICY.approval },
        sandbox: { ...DEFAULT_POLICY.sandbox }
      };
    }
    throw new Error(
      `Invalid Oracle policy at ${policyFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate workspace-relative file path against policy rules.
 */
export function validateFilePath(relPath: string, policy: OraclePolicy): void {
  const normalized = relPath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  for (const forbidden of policy.forbiddenGlobs) {
    const target = forbidden.toLowerCase();
    const matches =
      normalized === target ||
      normalized.includes(`/${target}`) ||
      normalized.endsWith(target) ||
      (target.endsWith(".") && segments.some((segment) => segment.startsWith(target)));
    if (matches) {
      logSandbox("mutation-denied", { requestedPath: relPath, rule: `forbidden_glob:${forbidden}` });
      throw new PolicyViolationError(`Access to '${relPath}' denied by security policy (forbidden pattern: ${forbidden})`, `forbidden_glob:${forbidden}`);
    }
  }
}

/**
 * Validate shell command string against command policy rules.
 */
export function validateCommand(command: string, policy: OraclePolicy): void {
  const normalized = command.trim().toLowerCase();

  for (const forbidden of policy.forbiddenCommands) {
    if (normalized.includes(forbidden.toLowerCase())) {
      logSandbox("mutation-denied", { command, rule: `forbidden_command:${forbidden}` });
      throw new PolicyViolationError(`Command Execution denied by security policy: forbidden pattern '${forbidden}'`, `forbidden_command:${forbidden}`);
    }
  }

  if (policy.allowedCommands && policy.allowedCommands.length > 0) {
    const allowed = policy.allowedCommands.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
    if (!allowed) {
      logSandbox("mutation-denied", { command, rule: "allowed_commands_mismatch" });
      throw new PolicyViolationError(`Command '${command}' does not match allowed command policy prefixes`, "allowed_commands_mismatch");
    }
  }
}
