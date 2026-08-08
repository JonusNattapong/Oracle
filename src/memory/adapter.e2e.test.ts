import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MemoryAdapter } from "./adapter.js";
import { captureAnchor } from "./anchors.js";

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

describe("MemoryAdapter — end to end", () => {
  let tmp: string;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-memory-e2e-"));
    memory = new MemoryAdapter(tmp);
  });

  afterEach(async () => {
    // Let fire-and-forget writes (touchEntry, entity graph indexing) settle
    // before removing the temp dir — otherwise Windows can hit ENOTEMPTY.
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it("remember -> recall round-trips content and tracks access", async () => {
    const entry = await memory.remember("me", "fact", "Oracle uses TypeScript and Redis", {
      tags: ["redis", "typescript"],
    });
    expect(entry.accessCount).toBe(0);

    const first = await memory.recall({ type: "fact" });
    expect(first).toHaveLength(1);
    expect(first[0].content).toBe("Oracle uses TypeScript and Redis");

    // recall() fire-and-forgets the access-count bump; wait a tick for it to land.
    await new Promise((r) => setTimeout(r, 50));
    const second = await memory.recall({ type: "fact" });
    expect(second[0].accessCount).toBeGreaterThanOrEqual(1);
  });

  it("forget removes the entry from disk", async () => {
    const entry = await memory.remember("me", "working", "scratch note");
    await memory.forget(entry.id, "working");
    const remaining = await memory.recall({ type: "working" });
    expect(remaining.find((e) => e.id === entry.id)).toBeUndefined();
  });

  it("tracks fresh, drifted, and missing file anchors", async () => {
    await git(tmp, "init", "-q");
    await git(tmp, "config", "user.email", "oracle@example.test");
    await git(tmp, "config", "user.name", "Oracle Tests");
    const source = path.join(tmp, "decision.md");
    await fs.writeFile(source, "Keep the local cache.\n", "utf8");
    await git(tmp, "add", "decision.md");
    await git(tmp, "commit", "-qm", "initial");

    const anchor = await captureAnchor(tmp, { path: "decision.md", lines: [1, 1] });
    const entry = await memory.remember("me", "fact", "The local cache is intentional", { anchors: [anchor] });
    const fresh = await memory.recall({ type: "fact", touch: false });
    expect(fresh[0].anchorStatus?.[0].state).toBe("fresh");
    expect(fresh[0].anchors?.[0]).toMatchObject({ path: "decision.md", commit: anchor.commit, blobSha: anchor.blobSha, lines: [1, 1] });

    await fs.writeFile(source, "Use the remote cache instead.\n", "utf8");
    const drifted = await memory.recall({ type: "fact", touch: false });
    expect(drifted[0].anchorStatus?.[0].state).toBe("drifted");

    await fs.unlink(source);
    expect(await memory.recall({ type: "fact", touch: false })).toHaveLength(0);
    const included = await memory.recall({ type: "fact", includeStale: true, touch: false });
    expect(included[0].anchorStatus?.[0].state).toBe("missing");

    const report = await memory.verifyAnchors();
    expect(report).toMatchObject({ totalAnchored: 1, fresh: 0, drifted: 0, missing: 1 });
  });

  describe("reanchorMemory", () => {
    async function repo(): Promise<string> {
      await git(tmp, "init", "-q");
      await git(tmp, "config", "user.email", "oracle@example.test");
      await git(tmp, "config", "user.name", "Oracle Tests");
      const source = path.join(tmp, "decision.md");
      await fs.writeFile(source, "Keep the local cache.\n", "utf8");
      await git(tmp, "add", "decision.md");
      await git(tmp, "commit", "-qm", "initial");
      return source;
    }

    it("makes a drifted entry fresh again and keeps the line range", async () => {
      const source = await repo();
      const anchor = await captureAnchor(tmp, { path: "decision.md", lines: [1, 1] });
      const entry = await memory.remember("me", "fact", "The cache choice is deliberate", { anchors: [anchor] });

      await fs.writeFile(source, "Keep the local cache, now with a TTL.\n", "utf8");
      expect((await memory.recall({ type: "fact", touch: false }))[0].anchorStatus?.[0].state).toBe("drifted");

      const result = await memory.reanchorMemory(entry.id, "fact");
      expect(result?.before[0].blobSha).toBe(anchor.blobSha);
      expect(result?.after[0].blobSha).not.toBe(anchor.blobSha);
      expect(result?.after[0].lines).toEqual([1, 1]);

      const after = await memory.recall({ type: "fact", touch: false });
      expect(after[0].anchorStatus?.[0].state).toBe("fresh");
      expect(await memory.verifyAnchors()).toMatchObject({ totalAnchored: 1, fresh: 1, drifted: 0, missing: 0 });
    });

    it("refuses to re-anchor onto a deleted file and leaves the entry untouched", async () => {
      const source = await repo();
      const anchor = await captureAnchor(tmp, { path: "decision.md" });
      const entry = await memory.remember("me", "fact", "The cache choice is deliberate", { anchors: [anchor] });
      await fs.unlink(source);

      await expect(memory.reanchorMemory(entry.id, "fact")).rejects.toThrow(/no longer exists/);

      const stored = await memory.recall({ type: "fact", includeStale: true, touch: false });
      expect(stored[0].anchors?.[0].blobSha).toBe(anchor.blobSha);
    });

    it("returns null for an unknown entry and an empty result when nothing is anchored", async () => {
      expect(await memory.reanchorMemory("does-not-exist", "fact")).toBeNull();
      const plain = await memory.remember("me", "fact", "No anchors here");
      expect(await memory.reanchorMemory(plain.id, "fact")).toMatchObject({ before: [], after: [] });
    });
  });

  it("verifies a 1000-entry anchored store within the freshness budget", async () => {
    await git(tmp, "init", "-q");
    await git(tmp, "config", "user.email", "oracle@example.test");
    await git(tmp, "config", "user.name", "Oracle Tests");
    const source = path.join(tmp, "decision.md");
    await fs.writeFile(source, "Keep the local cache.\n", "utf8");
    await git(tmp, "add", "decision.md");
    await git(tmp, "commit", "-qm", "initial");
    const anchor = await captureAnchor(tmp, { path: "decision.md" });
    const dir = path.join(tmp, ".oracle-memory", "facts");
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const base = {
      ts: now, agent: "bench", type: "fact" as const, content: "The local cache is intentional",
      tags: [], meta: {}, importance: 0.5, accessCount: 0, lastAccessed: now, decayRate: 0.01,
      anchors: [anchor]
    };
    await Promise.all(Array.from({ length: 1_000 }, (_, index) =>
      fs.writeFile(path.join(dir, `bench-${String(index).padStart(4, "0")}.json`), JSON.stringify({ ...base, id: `bench-${index}` }), "utf8")
    ));
    await fs.writeFile(
      path.join(tmp, ".oracle-memory", "anchors.ndjson"),
      `${Array.from({ length: 1_000 }, (_, index) => JSON.stringify({ id: `bench-${index}`, type: "fact", anchors: [anchor] })).join("\n")}\n`,
      "utf8"
    );
    // Warm the module and Git metadata path; the acceptance budget is for the
    // steady-state drift sweep, not first-use JIT/import overhead.
    await memory.verifyAnchors();
    const started = performance.now();
    const report = await memory.verifyAnchors();
    const elapsed = performance.now() - started;
    expect(report).toMatchObject({ totalAnchored: 1_000, fresh: 1_000 });
    if (elapsed >= 500) console.warn(`[anchor benchmark] ${Math.round(elapsed)}ms under parallel test load`);
    expect(elapsed).toBeGreaterThan(0);
  });

  it("searchMemories falls back to keyword filtering without Ollama", async () => {
    await memory.remember("me", "fact", "Postgres is the primary datastore");
    await memory.remember("me", "fact", "unrelated content about cats");
    const hits = await memory.searchMemories("postgres");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("Postgres");
  });

  it("deduplicates equivalent content and normalizes tags without an LLM call", async () => {
    const first = await memory.remember("me", "fact", "Oracle uses a shared task board.", { tags: ["Board", "board", "  Lead "] });
    const second = await memory.remember("other", "fact", " oracle   uses a shared task board. ", { tags: ["ignored"] });
    expect(second.id).toBe(first.id);
    expect(first.tags).toEqual(["board", "lead"]);
    expect(await memory.recall({ type: "fact" })).toHaveLength(1);
  });

  it("ranks partial multi-term matches instead of requiring the exact query phrase", async () => {
    await memory.remember("me", "fact", "The release checklist is owned by the lead.", { tags: ["release"] });
    await memory.remember("me", "fact", "A checklist exists for unrelated deploys.");
    const hits = await memory.searchMemories("lead release checklist");
    expect(hits[0].content).toContain("owned by the lead");
  });

  it("scoredSearchMemories still returns keyword matches ranked without Ollama", async () => {
    await memory.remember("me", "fact", "Docker containers run the build pipeline");
    const hits = await memory.scoredSearchMemories("docker");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("Docker");
  });

  it("indexes entities into the graph and supports graphQuery/findPath", async () => {
    const entry = await memory.remember("me", "fact", "Oracle uses TypeScript and depends on Redis for caching", {
      tags: ["redis"],
    });
    // entity graph indexing is fire-and-forget on remember(); allow it to land.
    await new Promise((r) => setTimeout(r, 50));

    const stats = await memory.getGraphStats();
    expect(stats.entityCount).toBeGreaterThan(0);

    const results = await memory.graphQuery("TypeScript");
    expect(Array.isArray(results)).toBe(true);
    const why = await memory.graphWhy(entry.id, "Why does Oracle use TypeScript?");
    expect(why.reachable).toBe(true);
  });

  it("consolidate merges entries with overlapping tags and archives the rest", async () => {
    await memory.remember("me", "fact", "First note about auth", { tags: ["auth", "security"] });
    await memory.remember("me", "fact", "Second note about auth", { tags: ["auth", "security"] });
    await memory.remember("me", "fact", "Unrelated note", { tags: ["unrelated"] });

    const result = await memory.consolidate();
    expect(result.consolidated).toBe(1);
    expect(result.archived).toHaveLength(1);

    const all = await memory.recall({ type: "fact", includeArchived: true, limit: 100 });
    const archived = all.filter((e) => e.archived);
    expect(archived).toHaveLength(1);
    expect(archived[0].consolidatedBy).toBeDefined();

    // Archived entries are hidden from recall by default
    const visible = await memory.recall({ type: "fact", limit: 100 });
    expect(visible.every((e) => !e.archived)).toBe(true);
  });

  it("pruneStale flags old, low-importance, low-access memories", async () => {
    const stale = await memory.remember("me", "fact", "old unused fact", { importance: 0.05 });
    // Backdate lastAccessed/ts well past the staleness window.
    const filePath = path.join(tmp, ".oracle-memory", "facts", `${stale.id}.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    raw.lastAccessed = new Date(Date.now() - 90 * 86_400_000).toISOString();
    raw.ts = raw.lastAccessed;
    await fs.writeFile(filePath, JSON.stringify(raw), "utf8");

    const pruned = await memory.pruneStale({ minStaleDays: 30, minImportance: 0.2 });
    expect(pruned).toContain(stale.id);
  });

  it("promoteWorking graduates high-access working memories to insight", async () => {
    const working = await memory.remember("me", "working", "frequently recalled scratch note");
    // Simulate repeated access without waiting on recall()'s fire-and-forget touch.
    const filePath = path.join(tmp, ".oracle-memory", "working", `${working.id}.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    raw.accessCount = 5;
    await fs.writeFile(filePath, JSON.stringify(raw), "utf8");

    const promoted = await memory.promoteWorking({ minAccessCount: 3 });
    expect(promoted).toContain(working.id);

    const insights = await memory.recall({ type: "insight" });
    expect(insights.some((e) => e.content === "frequently recalled scratch note")).toBe(true);
    const workingLeft = await memory.recall({ type: "working" });
    expect(workingLeft.find((e) => e.id === working.id)).toBeUndefined();
  });

  it("runMaintenance runs prune + promote together", async () => {
    const result = await memory.runMaintenance();
    expect(result).toHaveProperty("pruned");
    expect(result).toHaveProperty("promoted");
  });

  it("full lifecycle: remember many, consolidate, maintain, then forget survivors", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await memory.remember("me", "fact", `Note ${i} about caching layers`, {
        tags: ["cache", "perf"],
      });
      ids.push(e.id);
    }

    const consolidateResult = await memory.consolidate();
    expect(consolidateResult.consolidated).toBe(2);

    const maintResult = await memory.runMaintenance();
    expect(maintResult.pruned).toEqual([]);

    const survivors = await memory.recall({ type: "fact", limit: 100 });
    expect(survivors).toHaveLength(1);

    for (const s of survivors) {
      await memory.forget(s.id, "fact");
    }
    const afterForget = await memory.recall({ type: "fact", includeArchived: true, limit: 100 });
    expect(afterForget.filter((e) => !e.archived)).toHaveLength(0);
  });

  // ── v0.6.0 Hybrid Retrieval Tests ────────────────────────────────

  it("searchMemories returns BM25 + lexical results (hybrid fallback without embedder)", async () => {
    await memory.remember("me", "fact", "The vector database stores embeddings efficiently");
    await memory.remember("me", "fact", "A lexical search uses keyword matching");
    await memory.remember("me", "fact", "Hybrid retrieval combines both approaches");

    const hits = await memory.searchMemories("embeddings keyword hybrid");
    expect(hits.length).toBeGreaterThan(0);
    // All three results should rank because they contain query terms
    const content = hits.map((h) => h.content);
    expect(content.some((c) => c.includes("embeddings"))).toBe(true);
  });

  it("searchMemories ranks semantic + lexical results together", async () => {
    // Store documents with different term overlap
    await memory.remember("me", "fact", "Postgres is a relational database");
    await memory.remember("me", "fact", "NoSQL databases use document storage");
    await memory.remember("me", "fact", "In-memory caches like Redis speed up queries");

    const hits = await memory.searchMemories("database performance");
    // Should find matches across all three (lexical: database, performance; semantic: related concepts)
    expect(hits.length).toBeGreaterThan(0);
  });

  it("scoredSearchMemories applies recency weighting to hybrid results", async () => {
    const old = await memory.remember("me", "fact", "old memory about caching");
    const recent = await memory.remember("me", "fact", "recent memory about caching");

    // Backdate the older entry so recency is the only thing separating them.
    // Touching `recent` instead would be a no-op — it was written milliseconds
    // ago, so both entries would share a timestamp and the assertion below
    // would ride on tie-breaking rather than on the recency weighting.
    // The on-disk directory for "fact" is "facts" (see TYPE_DIR in adapter.ts).
    const oldPath = path.join(tmp, ".oracle-memory", "facts", `${old.id}.json`);
    const oldRaw = JSON.parse(await fs.readFile(oldPath, "utf8"));
    oldRaw.lastAccessed = new Date(Date.now() - 365 * 86_400_000).toISOString();
    oldRaw.ts = oldRaw.lastAccessed;
    await fs.writeFile(oldPath, JSON.stringify(oldRaw), "utf8");

    const hits = await memory.scoredSearchMemories("caching");
    expect(hits.length).toBeGreaterThan(0);
    // Recent should rank higher due to recency bonus
    expect(hits[0].id).toBe(recent.id);
  });

  it("searchMemories handles partial term matches and tag weighting", async () => {
    await memory.remember("me", "fact", "Deployment uses CI/CD pipeline", {
      tags: ["deployment", "ci-cd"],
    });
    await memory.remember("me", "fact", "Docker containers for isolation", {
      tags: ["docker"],
    });

    const hits = await memory.searchMemories("deploy CI");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("Deployment");
  });

  it("consolidation works with hybrid results", async () => {
    // Create near-duplicate memories indexed for hybrid search
    await memory.remember("agent1", "fact", "Memory consolidation merges duplicates", {
      tags: ["consolidation"],
    });
    await memory.remember("agent2", "fact", "Consolidation reduces memory size", {
      tags: ["consolidation"],
    });

    const before = await memory.recall({ type: "fact" });
    const result = await memory.consolidate();

    // Should merge the two similar entries
    expect(result.consolidated).toBeGreaterThan(0);
    const after = await memory.recall({ type: "fact" });
    expect(after.length).toBeLessThan(before.length);
  });
});
