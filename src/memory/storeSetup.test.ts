import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "./adapter.js";

/**
 * The store's directories are created once per adapter rather than on every
 * write — 100 writes issued 1006 recursive mkdir calls, and a CPU profile put
 * mkdir above everything else Oracle was doing. These pin the cases where the
 * memo must not turn into a stale assumption.
 */
describe("MemoryAdapter — store directory setup", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-store-setup-"));
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it("creates the store on first write", async () => {
    const memory = new MemoryAdapter(tmp);
    await memory.remember("me", "fact", "first");

    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(1);
  });

  it("recreates the store if it is deleted under a live adapter", async () => {
    const memory = new MemoryAdapter(tmp);
    await memory.remember("me", "fact", "before");
    await new Promise((r) => setTimeout(r, 150)); // let queued index writes settle
    await fs.rm(path.join(tmp, ".oracle-memory"), { recursive: true, force: true, maxRetries: 3 });

    // The memo says the directories exist; the filesystem disagrees. The write
    // has to succeed anyway rather than inherit that assumption.
    await expect(memory.remember("me", "fact", "after")).resolves.toBeDefined();
    expect((await memory.recall({ type: "fact", touch: false })).map((e) => e.content)).toEqual(["after"]);
  });

  it("keeps two adapters on one store independent", async () => {
    const a = new MemoryAdapter(tmp);
    const b = new MemoryAdapter(tmp);
    await a.remember("me", "fact", "from a");
    await b.remember("me", "fact", "from b");

    expect(await b.recall({ type: "fact", touch: false })).toHaveLength(2);
  });
});
