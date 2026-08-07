import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "./adapter.js";

/**
 * Memory had no way to say a fact stopped being true. "We use PostgreSQL" and
 * "we migrated to MySQL" both stayed live and were recalled with equal
 * standing, leaving the model to guess which one is current from two entries
 * that each read as settled.
 *
 * Supersession is asserted by the writer, never inferred from the text.
 */
describe("MemoryAdapter — supersession", () => {
  let tmp: string;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-supersede-"));
    memory = new MemoryAdapter(tmp);
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it("drops the replaced entry from recall and keeps the replacement", async () => {
    const old = await memory.remember("me", "fact", "Primary datastore is PostgreSQL");
    const now = await memory.remember("me", "fact", "Primary datastore is MySQL", { supersedes: [old.id] });

    const live = await memory.recall({ type: "fact", touch: false });
    expect(live.map((e) => e.content)).toEqual(["Primary datastore is MySQL"]);
    expect(now.supersedes).toEqual([old.id]);
  });

  it("drops the replaced entry from search", async () => {
    const old = await memory.remember("me", "fact", "Primary datastore is PostgreSQL");
    await memory.remember("me", "fact", "Primary datastore is MySQL", { supersedes: [old.id] });

    const hits = await memory.searchMemories("datastore", { type: "fact" });
    expect(hits.map((e) => e.content)).toEqual(["Primary datastore is MySQL"]);
  });

  it("keeps the chain walkable in both directions", async () => {
    const old = await memory.remember("me", "fact", "Deploys run on Heroku");
    const now = await memory.remember("me", "fact", "Deploys run on Fly.io", { supersedes: [old.id] });

    const all = await memory.recall({ type: "fact", includeArchived: true, touch: false });
    const replaced = all.find((e) => e.id === old.id);
    expect(replaced?.supersededBy).toBe(now.id);
    expect(all.find((e) => e.id === now.id)?.supersedes).toEqual([old.id]);
  });

  it("replaces several entries at once", async () => {
    const a = await memory.remember("me", "fact", "Rate limit is 100 rpm");
    const b = await memory.remember("me", "fact", "Rate limit is per API key");
    const merged = await memory.remember("me", "fact", "Rate limit is 500 rpm per API key", {
      supersedes: [a.id, b.id],
    });

    expect(merged.supersedes).toHaveLength(2);
    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(1);
  });

  it("supersedes across memory types", async () => {
    const note = await memory.remember("me", "working", "guessing the queue is SQS");
    await memory.remember("me", "fact", "Queue is RabbitMQ", { supersedes: [note.id] });

    expect(await memory.recall({ type: "working", touch: false })).toHaveLength(0);
  });

  it("chains: only the newest stays live", async () => {
    const v1 = await memory.remember("me", "fact", "Auth v1: sessions in cookies");
    const v2 = await memory.remember("me", "fact", "Auth v2: JWT in headers", { supersedes: [v1.id] });
    const v3 = await memory.remember("me", "fact", "Auth v3: JWT in httpOnly cookies", { supersedes: [v2.id] });

    const live = await memory.recall({ type: "fact", touch: false });
    expect(live.map((e) => e.id)).toEqual([v3.id]);
  });

  it("ignores unknown ids rather than failing the write", async () => {
    const entry = await memory.remember("me", "fact", "still worth storing", {
      supersedes: ["20990101-000000-000000-deadbeef"],
    });

    expect(entry.supersedes).toBeUndefined();
    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(1);
  });

  it("refuses to let an entry supersede itself through the dedupe path", async () => {
    const first = await memory.remember("me", "fact", "self reference");
    // Same content returns the same entry; naming it must not retire it.
    const again = await memory.remember("me", "fact", "self reference", { supersedes: [first.id] });

    expect(again.id).toBe(first.id);
    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(1);
  });

  it("lets the replaced text be remembered again as a fresh live entry", async () => {
    const old = await memory.remember("me", "fact", "Deploys run on Heroku");
    await memory.remember("me", "fact", "Deploys run on Fly.io", { supersedes: [old.id] });

    const revived = await memory.remember("me", "fact", "Deploys run on Heroku");
    expect(revived.id).not.toBe(old.id);
    expect(revived.supersededBy).toBeUndefined();
  });
});
