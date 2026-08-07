import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EntityGraph } from "./entityGraph.js";

// ── Pure helper functions are not exported; we test them indirectly through
//    the EntityGraph class behaviour.  The class exposes indexMemory,
//    expandQuery, findPath, removeMemory, and getStats.

describe("EntityGraph", () => {
  let tmp: string;
  let graph: EntityGraph;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "entity-graph-unit-"));
    graph = new EntityGraph(tmp);
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  // ── getStats ──────────────────────────────────────────────────────────

  it("starts empty", async () => {
    const stats = await graph.getStats();
    expect(stats.entityCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
  });

  // ── indexMemory ───────────────────────────────────────────────────────

  it("indexes entities from content and tags", async () => {
    await graph.indexMemory("mem-1", "Oracle uses TypeScript and depends on Redis for caching", [
      "redis",
    ]);
    const stats = await graph.getStats();
    expect(stats.entityCount).toBeGreaterThanOrEqual(3); // Oracle, TypeScript, Redis
    expect(stats.edgeCount).toBeGreaterThanOrEqual(1);
  });

  it("indexMemory is idempotent – re-indexing does not double-count entities", async () => {
    await graph.indexMemory("mem-1", "TypeScript is great", []);
    const stats1 = await graph.getStats();

    await graph.indexMemory("mem-1", "TypeScript is great", []);
    const stats2 = await graph.getStats();

    // Entities should have exactly one memoryId each
    expect(stats2.entityCount).toBe(stats1.entityCount);
  });

  it("indexMemory adds new entities on second call with different memoryId", async () => {
    await graph.indexMemory("mem-1", "TypeScript is typed", []);
    await graph.indexMemory("mem-2", "Redis is fast", ["redis"]);
    const stats = await graph.getStats();
    expect(stats.entityCount).toBeGreaterThanOrEqual(2);
  });

  it("handles content with no recognizable entities gracefully", async () => {
    await graph.indexMemory("mem-1", "the cat sat on the mat", []);
    const stats = await graph.getStats();
    // No capitalized words, no tags, no tech keywords → still may get empty
    expect(stats.entityCount).toBe(0);
  });

  it("extracts tech keywords case-insensitively", async () => {
    await graph.indexMemory("mem-1", "We use POSTGRESQL and DOCKER in production", []);
    const stats = await graph.getStats();
    // PostgreSQL and Docker should be recognized via canonical mapping
    expect(stats.entityCount).toBeGreaterThanOrEqual(2);
  });

  it("creates edges between co-occurring entities", async () => {
    await graph.indexMemory("mem-1", "The Node server uses Express for routing", []);
    const stats = await graph.getStats();
    // Node and Express should co-occur → one edge (or more if extra entities extracted)
    expect(stats.edgeCount).toBeGreaterThanOrEqual(1);
  });

  // ── extraction quality ────────────────────────────────────────────────

  it("does not turn generic heading words into entities", async () => {
    // Real memories are full of bullet headings. These became first-class nodes
    // purely for being capitalised and leading their line.
    await graph.indexMemory(
      "mem-1",
      "Status: shipped.\nKey Planning Documents Created.\nContains the Redis client.",
      []
    );
    const names = (await graph.listEntities(50)).map((e) => e.name);

    expect(names).not.toContain("Status");
    expect(names).not.toContain("Contains");
    expect(names).toContain("Redis");
  });

  it("keeps a real subject that happens to open a sentence", async () => {
    // The mirror of the rule above: technical notes routinely lead with their
    // subject, so position alone must not disqualify a name.
    await graph.indexMemory("mem-1", "Redis is fast", []);
    expect((await graph.listEntities(20)).map((e) => e.name)).toContain("Redis");
  });

  it("rejects inflected verb forms", async () => {
    await graph.indexMemory("mem-1", "The team Implemented and Verified the Redis cache", []);
    const names = (await graph.listEntities(20)).map((e) => e.name);

    expect(names).not.toContain("Implemented");
    expect(names).not.toContain("Verified");
  });

  it("does not split a multi-word phrase into its own member words", async () => {
    await graph.indexMemory("mem-1", "We shipped Browser Mode this week", []);
    const names = (await graph.listEntities(20)).map((e) => e.name);

    expect(names).toContain("Browser Mode");
    expect(names).not.toContain("Mode");
  });

  it("treats an entity as one node regardless of case", async () => {
    await graph.indexMemory("mem-1", "The CLI ships today", ["cli"]);
    const names = (await graph.listEntities(20)).map((e) => e.name.toLowerCase());

    expect(names.filter((n) => n === "cli")).toHaveLength(1);
  });

  it("links entities within a sentence, not across the whole memory", async () => {
    // The full cross-product made one long memory a complete graph, where every
    // pair read as a discovered relation.
    await graph.indexMemory(
      "mem-1",
      "Redis caches sessions. PostgreSQL stores orders. Docker runs both.",
      []
    );
    const stats = await graph.getStats();

    // Three sentences of two entities each, not every pair across the memory.
    expect(stats.edgeCount).toBeLessThan(6);
  });

  it("does not treat ordinary words that shadow tech keywords as technologies", async () => {
    // "Next" was ranked a top entity in a real workspace purely from prose.
    await graph.indexMemory(
      "mem-1",
      "The next step is to rest the workers and express the intent clearly.",
      []
    );
    const names = (await graph.listEntities(30)).map((e) => e.name);

    expect(names).not.toContain("next");
    expect(names).not.toContain("rest");
    expect(names).not.toContain("express");
  });

  it("still recognises those keywords when they name the product", async () => {
    await graph.indexMemory("mem-1", "We migrated the app to Next.js last week", []);
    expect((await graph.listEntities(30)).map((e) => e.name.toLowerCase())).toContain("next");

    await graph.indexMemory("mem-2", "The dashboard runs on Express behind nginx", []);
    expect((await graph.listEntities(30)).map((e) => e.name.toLowerCase())).toContain("express");
  });

  // ── rebuild ───────────────────────────────────────────────────────────

  it("rebuild discards entities the current extractor would not emit", async () => {
    // Simulates a graph indexed under looser rules: inject a node directly, then
    // rebuild from the memories themselves.
    await graph.indexMemory("mem-1", "Redis caches sessions", []);
    await graph.indexMemory("legacy", "Implemented Contains Status", []);

    const result = await graph.rebuild([
      { id: "mem-1", content: "Redis caches sessions", tags: [] }
    ]);

    expect(result.memoriesIndexed).toBe(1);
    const names = (await graph.listEntities(50)).map((e) => e.name);
    expect(names).toContain("Redis");
    expect(names).not.toContain("Implemented");
  });

  it("rebuild on no memories leaves an empty graph", async () => {
    await graph.indexMemory("mem-1", "Redis caches sessions", []);

    const result = await graph.rebuild([]);

    expect(result).toMatchObject({ entityCount: 0, edgeCount: 0, memoriesIndexed: 0 });
  });

  // ── expandQuery ───────────────────────────────────────────────────────

  it("expandQuery returns direct matches", async () => {
    await graph.indexMemory("mem-1", "TypeScript is a typed language", []);
    const result = await graph.expandQuery("TypeScript");
    expect(result.entities).toContain("TypeScript");
  });

  it("expandQuery returns related entities from multi-hop traversal", async () => {
    // Create three entities that co-occur so edges form
    await graph.indexMemory("mem-1", "Redis and TypeScript are both used by Oracle", ["redis"]);
    await graph.indexMemory("mem-2", "TypeScript compiles to JavaScript", []);
    await graph.indexMemory("mem-3", "Oracle runs on Linux servers", []);

    const result = await graph.expandQuery("TypeScript");
    expect(result.entities).toContain("TypeScript");
    // Related should contain Redis (co-occurred) and potentially JavaScript
    expect(result.related.length).toBeGreaterThan(0);
  });

  it("expandQuery returns empty arrays when graph is empty", async () => {
    const result = await graph.expandQuery("Nothing");
    expect(result.entities).toEqual([]);
    expect(result.related).toEqual([]);
  });

  it("expandQuery matches query case-insensitively", async () => {
    await graph.indexMemory("mem-1", "TypeScript is great", []);
    const result = await graph.expandQuery("typescript");
    expect(result.entities).toContain("TypeScript");
  });

  // ── findPath ──────────────────────────────────────────────────────────

  it("findPath returns the shortest path between two connected entities", async () => {
    // A ─uses→ B ─depends_on→ C
    await graph.indexMemory("mem-1", "Node uses TypeScript for development", []);
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    await graph.indexMemory("mem-2", "TypeScript depends on Node for runtime", []);

    const path = await graph.findPath("Node", "TypeScript");
    expect(path.length).toBeGreaterThan(0);
    expect(path[0].from).toBe("Node");
    expect(path[path.length - 1].to).toBe("TypeScript");
  });

  it("findPath returns [] when entities do not exist", async () => {
    const path = await graph.findPath("NonExistentOne", "NonExistentTwo");
    expect(path).toEqual([]);
  });

  it("findPath returns [] when same entity", async () => {
    await graph.indexMemory("mem-1", "Redis is fast", []);
    const path = await graph.findPath("Redis", "Redis");
    expect(path).toEqual([]);
  });

  it("findPath returns [] when no path exists within maxDepth", async () => {
    // Two disconnected groups
    await graph.indexMemory("mem-1", "Redis is fast", []);
    await graph.indexMemory("mem-2", "Python is interpreted", []);
    const path = await graph.findPath("Redis", "Python", 1);
    expect(path).toEqual([]); // No co-occurrence → no path
  });

  it("findPath respects maxDepth", async () => {
    // Create a longer path: Alpha - Beta - Gamma - Delta
    await graph.indexMemory("mem-1", "Alpha uses Beta for building", []);
    await graph.indexMemory("mem-2", "Beta uses Gamma for testing", []);
    await graph.indexMemory("mem-3", "Gamma uses Delta for deployment", []);

    // maxDepth=1 should not reach Delta from Alpha
    const pathShallow = await graph.findPath("Alpha", "Delta", 1);
    expect(pathShallow).toEqual([]);

    // maxDepth=3 should reach Delta from Alpha
    const pathDeep = await graph.findPath("Alpha", "Delta", 3);
    expect(pathDeep.length).toBeGreaterThan(0);
  });

  // ── removeMemory ──────────────────────────────────────────────────────

  it("removeMemory removes the memory contribution from entities and edges", async () => {
    await graph.indexMemory("mem-1", "TypeScript is typed", []);
    await graph.indexMemory("mem-2", "TypeScript is great", []);
    const statsBefore = await graph.getStats();
    expect(statsBefore.entityCount).toBeGreaterThan(0);

    await graph.removeMemory("mem-1");
    // Entity "TypeScript" should still exist if mem-2 still references it
    const statsAfter = await graph.getStats();
    expect(statsAfter.entityCount).toBeGreaterThanOrEqual(1);
  });

  it("removeMemory cleans up orphaned entities", async () => {
    await graph.indexMemory("mem-1", "UniqueEntityX is specialized", []);
    const statsBefore = await graph.getStats();
    const hasUnique = statsBefore.entityCount > 0;

    await graph.removeMemory("mem-1");
    const statsAfter = await graph.getStats();
    if (hasUnique) {
      expect(statsAfter.entityCount).toBeLessThan(statsBefore.entityCount);
    }
  });

  it("removeMemory on unknown id is a no-op", async () => {
    await graph.indexMemory("mem-1", "TypeScript", []);
    const statsBefore = await graph.getStats();
    await graph.removeMemory("nonexistent-id");
    const statsAfter = await graph.getStats();
    expect(statsAfter.entityCount).toBe(statsBefore.entityCount);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("handles concurrent indexMemory calls", async () => {
    await Promise.all([
      graph.indexMemory("mem-1", "Redis caching layer", ["redis"]),
      graph.indexMemory("mem-2", "PostgreSQL primary database", ["postgres"]),
      graph.indexMemory("mem-3", "TypeScript backend services", ["typescript"]),
    ]);
    const stats = await graph.getStats();
    expect(stats.entityCount).toBeGreaterThanOrEqual(3); // Redis, PostgreSQL, TypeScript
    expect(stats.edgeCount).toBeGreaterThanOrEqual(0);
  });

  it("maintains graph data across load-save cycle via filesystem", async () => {
    await graph.indexMemory("mem-1", "Redis persists data", ["redis"]);
    const statsBefore = await graph.getStats();

    // Saves are debounced, so reaching the filesystem is what has to be waited
    // on here — the in-process cache already has the entity either way.
    await graph.flush();

    // Create a new graph instance pointing at the same directory
    const graph2 = new EntityGraph(tmp);
    const statsAfter = await graph2.getStats();

    expect(statsAfter.entityCount).toBe(statsBefore.entityCount);
  });

  it("keeps indexed entities visible in-process before the debounced save lands", async () => {
    await graph.indexMemory("mem-1", "Redis persists data", ["redis"]);
    // No flush: a reader on this instance must not have to know about the timer.
    expect((await graph.getStats()).entityCount).toBeGreaterThan(0);
  });

  it("handles long content without crashing", async () => {
    const longContent = "TypeScript ".repeat(500) + "Redis ".repeat(500);
    await graph.indexMemory("mem-1", longContent, ["typescript"]);
    const stats = await graph.getStats();
    expect(stats.entityCount).toBeGreaterThan(0);
  });
});
