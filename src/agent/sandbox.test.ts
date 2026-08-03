import { describe, test, expect, afterEach } from "vitest";
import os from "node:os";
import {
  buildDockerArgs,
  buildNamespaceArgs,
  describeSandboxMode,
  detectSandboxMode,
  isNamespaceAvailable,
  runSandboxed,
  resetSandboxProbes,
  DEFAULT_SANDBOX_LIMITS,
} from "./sandbox.js";

afterEach(() => resetSandboxProbes());

describe("buildDockerArgs", () => {
  const args = buildDockerArgs("echo hi", "/work", DEFAULT_SANDBOX_LIMITS, "alpine:3.20");
  const flag = (name: string) => args[args.indexOf(name) + 1];

  test("denies the network by default", () => {
    expect(flag("--network")).toBe("none");
  });

  test("enables the network only when explicitly allowed", () => {
    const open = buildDockerArgs("echo hi", "/work", { ...DEFAULT_SANDBOX_LIMITS, allowNetwork: true });
    expect(open[open.indexOf("--network") + 1]).toBe("bridge");
  });

  test("caps memory and pins swap to the same ceiling", () => {
    // Without --memory-swap the memory cap can be bypassed via swap.
    expect(flag("--memory")).toBe("512m");
    expect(flag("--memory-swap")).toBe("512m");
  });

  test("sets a pid limit as the fork-bomb ceiling", () => {
    expect(flag("--pids-limit")).toBe("128");
  });

  test("drops capabilities and blocks privilege escalation", () => {
    expect(flag("--cap-drop")).toBe("ALL");
    expect(args).toContain("--security-opt");
    expect(flag("--security-opt")).toBe("no-new-privileges");
  });

  test("mounts the workspace read-write but the rest read-only", () => {
    expect(args).toContain("--read-only");
    expect(flag("--volume")).toBe("/work:/workspace");
    expect(flag("--workdir")).toBe("/workspace");
  });

  test("passes the command through sh -c as the final args", () => {
    expect(args.slice(-3)).toEqual(["sh", "-c", "echo hi"]);
  });

  test("honours custom cpu and memory limits", () => {
    const custom = buildDockerArgs("true", "/w", { ...DEFAULT_SANDBOX_LIMITS, cpus: 2, memoryMB: 1024 });
    expect(custom[custom.indexOf("--cpus") + 1]).toBe("2");
    expect(custom[custom.indexOf("--memory") + 1]).toBe("1024m");
  });
});

describe("buildNamespaceArgs", () => {
  test("unshares pid and user namespaces and applies a fork ceiling", () => {
    const args = buildNamespaceArgs("echo hi", DEFAULT_SANDBOX_LIMITS);
    expect(args).toContain("--pid");
    expect(args).toContain("--user");
    expect(args).toContain("--net");
    expect(args[args.length - 1]).toContain("ulimit -u 128");
    expect(args[args.length - 1]).toContain("echo hi");
  });

  test("keeps the network namespace shared when network is allowed", () => {
    const args = buildNamespaceArgs("echo hi", { ...DEFAULT_SANDBOX_LIMITS, allowNetwork: true });
    expect(args).not.toContain("--net");
  });
});

describe("detectSandboxMode", () => {
  // The docker probe is allowed 5s of its own; the suite-wide timeout in
  // vitest.config.ts gives this room to outlast it.
  test("returns a supported mode for this host", async () => {
    const mode = await detectSandboxMode();
    expect(["docker", "namespace", "none"]).toContain(mode);
  });

  test("namespaces are never reported as available off Linux", async () => {
    const available = await isNamespaceAvailable();
    if (os.platform() !== "linux") expect(available).toBe(false);
  });
});

describe("runSandboxed", () => {
  test("mode 'none' runs the command and returns its output", async () => {
    const result = await runSandboxed("echo sandboxed", { cwd: process.cwd(), mode: "none" });
    expect(result.stdout.trim()).toBe("sandboxed");
    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe("none");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a failing command reports its exit code rather than throwing", async () => {
    const result = await runSandboxed("exit 3", { cwd: process.cwd(), mode: "none" });
    expect(result.exitCode).toBe(3);
  });

  test("an unavailable explicit mode errors instead of silently downgrading", async () => {
    // Asking for containment and getting none without being told is the
    // failure this guards against.
    if (os.platform() === "linux" && (await isNamespaceAvailable())) return;
    await expect(
      runSandboxed("echo hi", { cwd: process.cwd(), mode: "namespace" })
    ).rejects.toThrow(/namespace/i);
  });
});

describe("describeSandboxMode", () => {
  test("states plainly that 'none' provides no isolation", () => {
    expect(describeSandboxMode("none")).toMatch(/no process or network isolation/);
  });

  test("describes docker and namespace containment", () => {
    expect(describeSandboxMode("docker")).toMatch(/container/);
    expect(describeSandboxMode("namespace")).toMatch(/namespace/);
  });
});
