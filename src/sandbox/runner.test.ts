import path from "node:path";
import { describe, expect, test } from "vitest";
import { redactCommand, SandboxExecutionError, SandboxRunner, type SandboxRunRecord } from "./runner.js";

describe("SandboxRunner", () => {
  test("redacts inline credentials from persisted command evidence", () => {
    expect(redactCommand("curl -H 'Authorization: Bearer top-secret' --token=abc API_KEY=xyz"))
      .not.toContain("top-secret");
    expect(redactCommand("curl -H 'Authorization: Bearer top-secret' --token=abc API_KEY=xyz"))
      .not.toContain("abc");
    expect(redactCommand("curl -H 'Authorization: Bearer top-secret' --token=abc API_KEY=xyz"))
      .not.toContain("xyz");
  });
  test("uses a hardened Docker command and records the execution", async () => {
    const records: SandboxRunRecord[] = [];
    const calls: Array<{ file: string; args: string[] }> = [];
    const root = path.resolve("workspace with spaces");
    const runner = new SandboxRunner({
      workspaceRoot: root,
      policy: {
        mode: "docker",
        image: "node:24-bookworm-slim",
        network: "none",
        memoryMb: 512,
        cpuCount: 1,
        pidsLimit: 64,
        environment: ["ORACLE_SANDBOX_TEST"]
      },
      recorder: { recordSandboxRun: (record) => records.push(record) },
      execute: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 7 };
      }
    });

    const result = await runner.run("node --version", 10_000);

    expect(result.stdout).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("docker");
    expect(calls[0].args).toEqual(expect.arrayContaining([
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--network", "none", "--workdir", "/workspace", "node:24-bookworm-slim", "sh", "-lc", "node --version"
    ]));
    expect(calls[0].args).toContain(`type=bind,src=${root},dst=/workspace`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      mode: "docker", network: "none", exitCode: 0, durationMs: 7, workspaceRoot: root
    });
    expect(records[0].commandHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fails closed and records a failed Docker startup without a host fallback", async () => {
    const records: SandboxRunRecord[] = [];
    const calls: string[] = [];
    const runner = new SandboxRunner({
      workspaceRoot: process.cwd(),
      policy: { mode: "docker", image: "missing", network: "none", memoryMb: 512, cpuCount: 1, pidsLimit: 64, environment: [] },
      recorder: { recordSandboxRun: (record) => records.push(record) },
      execute: async (file) => {
        calls.push(file);
        throw new SandboxExecutionError("Docker is unavailable", { durationMs: 3 });
      }
    });

    await expect(runner.run("echo should-not-run-on-host", 10_000)).rejects.toThrow("Docker is unavailable");
    expect(calls).toEqual(["docker"]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ mode: "docker", exitCode: null, error: "Docker is unavailable" });
  });
});
