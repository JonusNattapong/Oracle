import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, loadPolicy, validateCommand, validateFilePath, PolicyViolationError } from "./policy.js";

describe("OraclePolicy Enforcement", () => {
  it("allows standard workspace relative paths", () => {
    expect(() => validateFilePath("src/index.ts", DEFAULT_POLICY)).not.toThrow();
    expect(() => validateFilePath("README.md", DEFAULT_POLICY)).not.toThrow();
  });

  it("blocks forbidden globs and sensitive files", () => {
    expect(() => validateFilePath(".env", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateFilePath(".env.production", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateFilePath("config/.env.local", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateFilePath("keys/id_rsa", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateFilePath("server.pem", DEFAULT_POLICY)).toThrow(PolicyViolationError);
  });

  it("validates command execution blacklists", () => {
    expect(() => validateCommand("npm test", DEFAULT_POLICY)).not.toThrow();
    expect(() => validateCommand("rm -rf /", DEFAULT_POLICY)).toThrow(PolicyViolationError);
    expect(() => validateCommand("dd if=/dev/zero", DEFAULT_POLICY)).toThrow(PolicyViolationError);
  });

  it("enforces allowed command prefixes when set", () => {
    const strictPolicy = {
      ...DEFAULT_POLICY,
      allowedCommands: ["npm", "git", "node"],
    };

    expect(() => validateCommand("npm test", strictPolicy)).not.toThrow();
    expect(() => validateCommand("git status", strictPolicy)).not.toThrow();
    expect(() => validateCommand("curl https://malicious.site", strictPolicy)).toThrow(PolicyViolationError);
  });

  it("fails closed when policy JSON is invalid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-policy-"));
    try {
      await fs.mkdir(path.join(root, ".oracle"));
      await fs.writeFile(path.join(root, ".oracle", "policy.json"), "{ invalid", "utf8");
      await expect(loadPolicy(root)).rejects.toThrow(/Invalid Oracle policy/);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("loads Docker sandbox policy with a network-deny default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-policy-sandbox-"));
    try {
      await fs.mkdir(path.join(root, ".oracle"));
      await fs.writeFile(path.join(root, ".oracle", "policy.json"), JSON.stringify({
        sandbox: { mode: "docker", memoryMb: 512, environment: ["NODE_ENV"] }
      }), "utf8");
      await expect(loadPolicy(root)).resolves.toMatchObject({
        sandbox: { mode: "docker", network: "none", memoryMb: 512, environment: ["NODE_ENV"] }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("rejects network-enabled sandbox policy until an egress broker exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-policy-sandbox-network-"));
    try {
      await fs.mkdir(path.join(root, ".oracle"));
      await fs.writeFile(path.join(root, ".oracle", "policy.json"), JSON.stringify({
        sandbox: { mode: "docker", network: "restricted" }
      }), "utf8");
      await expect(loadPolicy(root)).rejects.toThrow("sandbox.network must be none");
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
