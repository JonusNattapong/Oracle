import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "./adapter.js";

/**
 * remember() rejects a re-write of content it already holds. That check used to
 * scan every entry in the type dir, making each write O(store size); a content
 * hash index replaced the scan. These pin the behaviour the index has to keep,
 * including the cases where a stale pointer must read as a miss.
 */
describe("MemoryAdapter — content index preserves dedupe semantics", () => {
  let tmp: string;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-content-idx-"));
    memory = new MemoryAdapter(tmp);
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns the original entry for identical content", async () => {
    const first = await memory.remember("me", "fact", "Redis holds refresh tokens");
    const second = await memory.remember("me", "fact", "Redis holds refresh tokens");

    expect(second.id).toBe(first.id);
    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(1);
  });

  it("treats content differing only by case and whitespace as duplicate", async () => {
    const first = await memory.remember("me", "fact", "Redis holds refresh tokens");
    const second = await memory.remember("me", "fact", "  redis   HOLDS refresh tokens  ");

    expect(second.id).toBe(first.id);
  });

  it("keeps the same text under a different type", async () => {
    const asFact = await memory.remember("me", "fact", "shared text");
    const asInsight = await memory.remember("me", "insight", "shared text");

    expect(asInsight.id).not.toBe(asFact.id);
  });

  it("writes a fresh entry after the original was forgotten", async () => {
    const first = await memory.remember("me", "fact", "ephemeral note");
    await memory.forget(first.id, "fact");

    const second = await memory.remember("me", "fact", "ephemeral note");
    expect(second.id).not.toBe(first.id);
    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(1);
  });

  it("writes a fresh entry after the original was pruned", async () => {
    const first = await memory.remember("me", "fact", "superseded runbook");
    await memory.pruneStale({ minStaleDays: -1, minImportance: 1 });

    const second = await memory.remember("me", "fact", "superseded runbook");
    expect(second.id).not.toBe(first.id);
    expect(second.pruned).toBeFalsy();
  });

  it("dedupes against the new text after an update, not the old", async () => {
    const first = await memory.remember("me", "fact", "old wording");
    await memory.updateMemory(first.id, "fact", { content: "new wording" });

    const sameNew = await memory.remember("me", "fact", "new wording");
    expect(sameNew.id).toBe(first.id);

    const oldAgain = await memory.remember("me", "fact", "old wording");
    expect(oldAgain.id).not.toBe(first.id);
  });

  it("dedupes a store written before the index existed", async () => {
    const first = await memory.remember("me", "fact", "pre-index entry");
    // Simulate an older store: entries on disk, no index file.
    await fs.rm(path.join(tmp, ".oracle-memory", "content-index.ndjson"), { force: true });
    const fresh = new MemoryAdapter(tmp);

    const second = await fresh.remember("me", "fact", "pre-index entry");
    expect(second.id).toBe(first.id);
  });

  it("recovers from a corrupt index", async () => {
    const first = await memory.remember("me", "fact", "entry behind a bad index");
    await fs.writeFile(path.join(tmp, ".oracle-memory", "content-index.ndjson"), "not json\n{\n", "utf8");
    const fresh = new MemoryAdapter(tmp);

    // Corrupt rows are skipped, so the surviving index is empty and this write
    // is a miss — a duplicate, not a crash.
    await expect(fresh.remember("me", "fact", "entry behind a bad index")).resolves.toBeDefined();
    expect(first.id).toBeDefined();
  });

  it("stays correct across separate adapter instances on one store", async () => {
    const first = await memory.remember("me", "fact", "cross instance");
    const other = new MemoryAdapter(tmp);

    const second = await other.remember("me", "fact", "cross instance");
    expect(second.id).toBe(first.id);
  });
});
