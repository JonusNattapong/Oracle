import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { OrchestratorFactory } from "./factory.js";

describe("OrchestratorFactory", () => {
  let tempDir: string;
  let factory: OrchestratorFactory;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-orchestrator-"));
    factory = new OrchestratorFactory(tempDir, tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("builds a working local adapter with no external service", async () => {
    const memAdapter = await factory.createMemoryAdapter();

    expect(memAdapter).toBeDefined();
    expect(memAdapter.remember).toBeDefined();
  });

  it("supports the full remember/recall/forget cycle", async () => {
    const memAdapter = await factory.createMemoryAdapter();

    const entry = await memAdapter.remember("test-agent", "fact", "Test memory", {
      tags: ["test"],
      importance: 0.8,
    });

    expect(entry.agent).toBe("test-agent");
    expect(entry.type).toBe("fact");
    expect(entry.content).toBe("Test memory");

    const recalled = await memAdapter.recall({ type: "fact", agent: "test-agent" });
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0].id).toBe(entry.id);

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

  it("writes to .oracle-memory/, the format the retired sidecar also read", async () => {
    const memAdapter = await factory.createMemoryAdapter();
    await memAdapter.remember("agent", "fact", "on-disk format check");

    const facts = await fs.readdir(path.join(tempDir, ".oracle-memory", "facts"));
    expect(facts.length).toBeGreaterThan(0);
  });
});
