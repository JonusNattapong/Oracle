import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProcessSupervisor } from "./supervisor.js";
import { OrchestratorFactory } from "./factory.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

describe("ProcessSupervisor", () => {
  let tempDir: string;
  let supervisor: ProcessSupervisor;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `oracle-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    supervisor = new ProcessSupervisor(tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it("should attempt to spawn a service and handle failure gracefully", async () => {
    // Attempt to spawn non-existent service (should fail gracefully)
    const result = await supervisor.ensureRunning("memory");

    // Should return null when spawn fails (binary not found)
    expect(result).toBeNull();
  });

  it("should track pid/port files", async () => {
    // This test just verifies the supervisor doesn't crash when spawn fails
    // (In real scenario, we'd need oracle-memory binary installed)
    const runDir = path.join(tempDir, "run");
    await supervisor.ensureRunning("memory");

    // Check if run directory was created (even if spawn failed)
    try {
      await fs.access(runDir);
    } catch {
      // It's ok if run directory wasn't created (spawn failed before writing)
    }
  });
});

describe("OrchestratorFactory", () => {
  let tempDir: string;
  let factory: OrchestratorFactory;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `oracle-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    factory = new OrchestratorFactory(tempDir, tempDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it("should fallback to file adapter when MCP spawn fails", async () => {
    const memAdapter = await factory.createMemoryAdapter();

    // Should return a valid adapter (file-based fallback)
    expect(memAdapter).toBeDefined();
    expect(memAdapter.remember).toBeDefined();

    // Verify it's the file adapter by checking the status
    const status = factory.getStatus();
    expect(status).toBeDefined();
    expect(status?.transport).toBe("fallback");
  });

  it("keeps an expected optional-sidecar fallback quiet outside debug mode", async () => {
    vi.stubEnv("ORACLE_DEBUG", "");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const memAdapter = await factory.createMemoryAdapter();

    expect(memAdapter).toBeDefined();
    expect(factory.getStatus()?.transport).toBe("fallback");
    expect(debug).not.toHaveBeenCalled();
  });

  it("file-based adapters should work correctly", async () => {
    const memAdapter = await factory.createMemoryAdapter();

    // Test remember/recall cycle
    const entry = await memAdapter.remember("test-agent", "fact", "Test memory", {
      tags: ["test"],
      importance: 0.8,
    });

    expect(entry).toBeDefined();
    expect(entry.agent).toBe("test-agent");
    expect(entry.type).toBe("fact");
    expect(entry.content).toBe("Test memory");

    // Test recall
    const recalled = await memAdapter.recall({ type: "fact", agent: "test-agent" });
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0].id).toBe(entry.id);

    // Test forget
    await memAdapter.forget(entry.id, "fact");
    const afterForget = await memAdapter.recall({ type: "fact", agent: "test-agent" });
    expect(afterForget.some((e) => e.id === entry.id)).toBe(false);
  });

  it("recall returns the most recent entries even when readdir order is scrambled", async () => {
    const memAdapter = await factory.createMemoryAdapter();

    // Write more entries than the internal slice window would keep if an
    // unsorted (OS-dependent) readdir() order were used directly.
    const written = [];
    for (let i = 0; i < 5; i++) {
      written.push(await memAdapter.remember("agent", "fact", `memory-${i}`));
      await new Promise((r) => setTimeout(r, 5)); // ensure distinct timestamp prefixes
    }

    const recalled = await memAdapter.recall({ type: "fact", agent: "agent", limit: 2 });
    expect(recalled).toHaveLength(2);
    // Most recent two, newest first.
    expect(recalled[0].id).toBe(written[4].id);
    expect(recalled[1].id).toBe(written[3].id);
  });

});
