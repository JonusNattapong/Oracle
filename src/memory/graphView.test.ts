import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EntityGraph } from "./entityGraph.js";

describe("EntityGraph graph view", () => {
  let tmp: string;
  let graph: EntityGraph;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-graphview-"));
    graph = new EntityGraph(tmp);
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  test("an empty graph renders as empty, not as an error", async () => {
    const view = await graph.toGraphView();
    expect(view.nodes).toEqual([]);
    expect(view.edges).toEqual([]);
    expect(view.stats).toEqual({
      totalEntities: 0,
      totalEdges: 0,
      renderedEntities: 0,
      truncated: false,
    });
  });

  test("indexed memories become nodes carrying their memory counts", async () => {
    await graph.indexMemory("m1", "Oracle uses TypeScript and Redis for caching", ["redis"]);
    const view = await graph.toGraphView();

    expect(view.nodes.length).toBeGreaterThan(0);
    expect(view.stats.totalEntities).toBe(view.nodes.length);
    for (const node of view.nodes) {
      expect(node.memoryCount).toBeGreaterThan(0);
      expect(node.label).toBeTruthy();
      expect(node.lastSeen).toBeTruthy();
    }
  });

  test("every edge endpoint exists among the rendered nodes", async () => {
    await graph.indexMemory("m1", "Oracle depends on Redis and Docker", ["infra"]);
    await graph.indexMemory("m2", "Docker runs the Postgres container", ["infra"]);

    const view = await graph.toGraphView();
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const edge of view.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });

  test("a truncated view says so rather than passing as the whole graph", async () => {
    await graph.indexMemory("m1", "Oracle uses TypeScript, Redis, Docker, Postgres and Kubernetes", []);
    const full = await graph.toGraphView();

    const limited = await graph.toGraphView({ limit: 1 });
    expect(limited.nodes).toHaveLength(1);
    expect(limited.stats.renderedEntities).toBe(1);
    expect(limited.stats.totalEntities).toBe(full.stats.totalEntities);
    expect(limited.stats.truncated).toBe(true);
    // Dropping nodes must not leave dangling edges behind.
    expect(limited.edges).toEqual([]);
  });

  test("nodes are ordered by connectedness so the layout keeps what matters", async () => {
    await graph.indexMemory("m1", "Oracle depends on Redis", []);
    await graph.indexMemory("m2", "Oracle depends on Docker", []);
    await graph.indexMemory("m3", "Oracle depends on Postgres", []);

    const view = await graph.toGraphView();
    const degrees = view.nodes.map((n) => n.degree);
    expect(degrees).toEqual([...degrees].sort((a, b) => b - a));
  });

  test("getEntity returns relations with their direction", async () => {
    await graph.indexMemory("m1", "Oracle depends on Redis for caching", ["redis"]);
    const view = await graph.toGraphView();
    const connected = view.nodes.find((n) => n.degree > 0);
    if (!connected) return; // extraction found no relation to assert on

    const detail = await graph.getEntity(connected.id);
    expect(detail).not.toBeNull();
    expect(detail!.memoryIds).toContain("m1");
    for (const rel of detail!.relations) {
      expect(["in", "out"]).toContain(rel.direction);
      expect(rel.other).not.toBe(connected.id);
    }
  });

  test("getEntity resolves case-insensitively and returns null for unknown names", async () => {
    await graph.indexMemory("m1", "Oracle uses Redis", []);
    const view = await graph.toGraphView();
    const first = view.nodes[0];

    expect(await graph.getEntity(first.id.toUpperCase())).not.toBeNull();
    expect(await graph.getEntity("no-such-entity-anywhere")).toBeNull();
  });

  test("listEntities returns entities ranked by degree", async () => {
    await graph.indexMemory("m1", "Oracle depends on Redis and Docker", []);
    const entities = await graph.listEntities(10);
    expect(entities.length).toBeGreaterThan(0);
    const degrees = entities.map((e) => e.degree);
    expect(degrees).toEqual([...degrees].sort((a, b) => b - a));
  });

  test("includeIsolated:false drops entities that have no edges", async () => {
    await graph.indexMemory("m1", "Oracle depends on Redis", []);
    const withIsolated = await graph.toGraphView({ includeIsolated: true });
    const withoutIsolated = await graph.toGraphView({ includeIsolated: false });

    expect(withoutIsolated.nodes.every((n) => n.degree > 0)).toBe(true);
    expect(withoutIsolated.nodes.length).toBeLessThanOrEqual(withIsolated.nodes.length);
  });
});
