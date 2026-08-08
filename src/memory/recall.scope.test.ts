import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "./adapter.js";

/**
 * Recall used to truncate each type dir to the newest `limit * 4` files and
 * only then apply the archived/agent/tag filters, so a match that was merely
 * older than that window came back as an empty result rather than a hit. The
 * lexical search fallback inherited the same ceiling through its candidate
 * pool, which turned "not scanned" into "no such memory".
 *
 * Each case here buries a single known entry behind enough newer noise to
 * clear the old window.
 */
describe("MemoryAdapter — recall scope beyond the newest entries", () => {
  let tmp: string;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-recall-scope-"));
    memory = new MemoryAdapter(tmp);
  });

  afterEach(async () => {
    // Let fire-and-forget writes settle before rm, or Windows hits ENOTEMPTY.
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it("finds a tagged entry buried behind newer untagged ones", { timeout: 60_000 }, async () => {
    await memory.remember("me", "fact", "the tagged one", { tags: ["target"] });
    for (let i = 0; i < 120; i++) {
      await memory.remember("me", "fact", `noise ${i}`, { tags: ["noise"] });
    }

    const hits = await memory.recall({ type: "fact", tags: ["target"], limit: 20, touch: false });
    expect(hits.map((h) => h.content)).toEqual(["the tagged one"]);
  });

  it("finds another agent's entry buried behind newer ones", { timeout: 60_000 }, async () => {
    await memory.remember("reviewer", "fact", "reviewer note");
    for (let i = 0; i < 120; i++) {
      await memory.remember("me", "fact", `noise ${i}`);
    }

    const hits = await memory.recall({ type: "fact", agent: "reviewer", limit: 20, touch: false });
    expect(hits.map((h) => h.content)).toEqual(["reviewer note"]);
  });

  // The lexical fallback used to draw max(limit * 4, 100) candidates, so 150
  // pieces of noise put the target well outside the old window. Kept just past
  // that boundary rather than an order of magnitude beyond it: remember()
  // rescans the whole type dir on every write to dedupe, which makes seeding
  // this fixture quadratic in the noise count.
  it("keyword search reaches an old entry behind newer noise", { timeout: 60_000 }, async () => {
    await memory.remember("me", "fact", "zebra crossing telemetry pipeline");
    for (let i = 0; i < 150; i++) {
      await memory.remember("me", "fact", `unrelated filler entry number ${i}`);
    }

    const hits = await memory.searchMemories("zebra", { type: "fact", limit: 10 });
    expect(hits.map((h) => h.content)).toContain("zebra crossing telemetry pipeline");
  });

  it("still returns the newest entries first when nothing is filtered", async () => {
    for (let i = 0; i < 30; i++) {
      await memory.remember("me", "fact", `entry ${i}`);
    }

    const hits = await memory.recall({ type: "fact", limit: 3, touch: false });
    expect(hits.map((h) => h.content)).toEqual(["entry 29", "entry 28", "entry 27"]);
  });

  /**
   * The case above is only deterministic because timestamps are strictly
   * increasing. Wall-clock time resolves to the millisecond, so on a fast host
   * a burst of writes used to share a stamp and leave recall order undefined —
   * which is exactly how it failed, intermittently and only on CI.
   */
  it("stamps a burst of writes with strictly increasing timestamps", async () => {
    const written = [];
    for (let i = 0; i < 50; i++) {
      written.push(await memory.remember("me", "fact", `burst ${i}`));
    }

    const stamps = written.map((entry) => entry.ts);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
  });
});
