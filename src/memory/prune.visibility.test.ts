import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "./adapter.js";

/**
 * pruneStaleMemories documents itself as a soft delete: the entry stays on disk
 * for auditability but should stop surfacing as live memory. Only reflect.ts
 * ever honoured the flag, so a pruned entry still came back from recall and
 * search and was still injected into consults — a delete that deleted nothing.
 *
 * Thresholds are passed explicitly here so these cases test visibility, not the
 * (separately tracked) question of when prune decides to fire.
 */
describe("MemoryAdapter — pruned entries are hidden from live recall", () => {
  let tmp: string;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-prune-vis-"));
    memory = new MemoryAdapter(tmp);
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  /** Force a prune regardless of the entry's age or importance. */
  const forcePrune = () => memory.pruneStale({ minStaleDays: -1, minImportance: 1 });

  it("drops a pruned entry from recall", async () => {
    await memory.remember("me", "fact", "obsolete deployment runbook");
    await memory.remember("me", "fact", "current deployment runbook");

    const pruned = await forcePrune();
    expect(pruned).toHaveLength(2);

    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(0);
  });

  it("drops a pruned entry from keyword search", async () => {
    await memory.remember("me", "fact", "kafka retention policy is seven days");
    await forcePrune();

    const hits = await memory.searchMemories("kafka", { type: "fact" });
    expect(hits).toHaveLength(0);
  });

  it("still exposes pruned entries when archived ones are requested", async () => {
    await memory.remember("me", "fact", "obsolete deployment runbook");
    await forcePrune();

    const all = await memory.recall({ type: "fact", includeArchived: true, touch: false });
    expect(all.map((e) => e.content)).toEqual(["obsolete deployment runbook"]);
  });

  it("leaves unpruned entries alone", async () => {
    await memory.remember("me", "fact", "kept");
    // minImportance 0 prunes nothing: every entry's importance is >= 0.
    await memory.pruneStale({ minStaleDays: -1, minImportance: 0 });

    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(1);
  });
});
