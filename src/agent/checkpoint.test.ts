import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { CheckpointStore, type AgentCheckpoint } from "./checkpoint.js";
import type { AgentMessage } from "./types.js";

describe("CheckpointStore", () => {
  const dir = path.join(os.tmpdir(), `oracle-checkpoint-test-${Date.now()}`);
  const store = new CheckpointStore(dir);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const sampleTranscript: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "do something" }] },
  ];

  const makeCp = (overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
    id: "cp-test-001",
    system: "test system",
    model: "test-model",
    transcript: sampleTranscript,
    turn: 3,
    maxSteps: 10,
    usage: { inputTokens: 100, outputTokens: 50 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  it("saves and loads a checkpoint", async () => {
    const cp = makeCp();
    await store.save(cp);
    const loaded = await store.load(cp.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(cp.id);
    expect(loaded!.turn).toBe(3);
    expect(loaded!.usage.inputTokens).toBe(100);
  });

  it("returns null for missing checkpoint", async () => {
    const loaded = await store.load("cp-nonexistent");
    expect(loaded).toBeNull();
  });

  it("deletes a checkpoint", async () => {
    const cp = makeCp({ id: "cp-test-delete" });
    await store.save(cp);
    expect(await store.load(cp.id)).not.toBeNull();
    const deleted = await store.delete(cp.id);
    expect(deleted).toBe(true);
    expect(await store.load(cp.id)).toBeNull();
  });

  it("delete returns false for missing checkpoint", async () => {
    const deleted = await store.delete("cp-nonexistent");
    expect(deleted).toBe(false);
  });

  it("lists checkpoints newest first", async () => {
    const oldCp = makeCp({ id: "cp-sort-old", updatedAt: "2020-01-01T00:00:00.000Z" });
    const newCp = makeCp({ id: "cp-sort-new", updatedAt: "2025-01-01T00:00:00.000Z" });
    await store.save(oldCp);
    await store.save(newCp);
    const list = await store.list();
    const sortItems = list.filter((c) => c.id.startsWith("cp-sort-"));
    expect(sortItems.length).toBe(2);
    // newest first
    expect(sortItems[0].id).toBe("cp-sort-new");
  });

  it("handles invalid checkpoint ids gracefully", async () => {
    // load returns null for invalid ids (caught by filePath validation)
    const loaded = await store.load("../evil");
    expect(loaded).toBeNull();
    // delete returns false for invalid ids
    const deleted = await store.delete("../evil");
    expect(deleted).toBe(false);
    // save rejects invalid ids
    await expect(store.save(makeCp({ id: "../evil" }))).rejects.toThrow();
  });
});
