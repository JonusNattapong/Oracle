import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MemoryPort } from "../../orchestrator/ports.js";
import { success, failure } from "../response.js";
import { captureAnchors } from "../../memory/anchors.js";

const SCOPE = z.enum(["project", "global"]).default("project");
const MEMORY_TYPE = z.enum(["fact", "insight", "chunk", "working"]);

/**
 * Four memory tools, down from nineteen.
 *
 * The old surface split one concept across many entries — list, search and
 * scored_search all read memory; consolidate, prune, promote and maintenance
 * all tidy it — which cost every connected client context and gave it four ways
 * to make the same decision wrong. Reading is now one tool with a mode, and
 * housekeeping is one tool with an action.
 *
 * Entity-graph browsing and the compiled wiki are not here: they are for a
 * person exploring what Oracle knows, and `oracle memory graph` and
 * `oracle wiki` already serve that on the CLI.
 */
export function registerMemoryTools(
  server: McpServer,
  deps: { memory: MemoryPort; globalMemory: MemoryPort; workspaceRoot: string }
): void {
  const { memory, globalMemory, workspaceRoot } = deps;
  const store = (scope: "project" | "global") => (scope === "global" ? globalMemory : memory);

  server.registerTool(
    "oracle_memory_remember",
    {
      title: "Save Memory",
      description: "Save a memory (project by default, global for cross-project knowledge).",
      inputSchema: {
        scope: SCOPE,
        agent: z.string().min(1),
        type: MEMORY_TYPE,
        content: z.string().min(1).max(20_000),
        tags: z.array(z.string().min(1)).max(50).optional(),
        importance: z.number().min(0).max(1).optional(),
        anchors: z.array(z.object({
          path: z.string().min(1),
          lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional()
        })).max(20).optional().describe("Workspace files that support this memory")
      }
    },
    async ({ scope, agent, type, content, tags, importance, anchors }) => {
      try {
        if (anchors?.length && scope === "global") throw new Error("File anchors are only supported for project memory");
        const captured = anchors?.length ? await captureAnchors(workspaceRoot, anchors) : undefined;
        const entry = await store(scope).remember(agent, type, content, { tags, importance, anchors: captured });
        return success(`Saved ${scope} memory ${entry.id}.`, { scope, memory: entry });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_search",
    {
      title: "Search Memory",
      description:
        "Read memory. With `query`, searches by relevance; without it, returns the most recent entries. "
        + "`mode: \"graph\"` expands the query with related entities from the knowledge graph.",
      inputSchema: {
        scope: SCOPE,
        query: z.string().min(1).optional().describe("Omit to list recent entries instead of searching"),
        mode: z.enum(["text", "graph"]).default("text"),
        agent: z.string().optional(),
        type: MEMORY_TYPE.optional(),
        tags: z.array(z.string().min(1)).optional().describe("Only applies when listing (no query)"),
        limit: z.number().int().min(1).max(200).default(20),
        include_stale: z.boolean().default(false).describe("Include memories whose anchored files are missing")
      }
    },
    async ({ scope, query, mode, agent, type, tags, limit, include_stale }) => {
      try {
        const target = store(scope);
        const options = { type, agent: agent ?? undefined, limit, includeStale: include_stale };
        const entries = !query
          ? await target.recall({ ...options, tags })
          : mode === "graph"
            ? (await target.graphQuery?.(query, { agent: agent ?? undefined, limit, includeStale: include_stale })) ?? []
            : await target.searchMemories(query, options);
        return success(JSON.stringify(entries, null, 2), {
          scope,
          mode: query ? mode : "recent",
          count: entries.length,
          entries
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_update",
    {
      title: "Update Memory",
      description: "Correct the content, tags, or importance of a stored memory.",
      inputSchema: {
        scope: SCOPE,
        id: z.string(),
        type: MEMORY_TYPE,
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        importance: z.number().min(0).max(1).optional()
      }
    },
    async ({ scope, id, type, content, tags, importance }) => {
      try {
        const updated = await store(scope).updateMemory(id, type, { content, tags, importance });
        if (!updated) return failure(new Error("Memory not found"));
        return success(JSON.stringify(updated, null, 2), { scope, memory: updated });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_maintain",
    {
      title: "Maintain Memory",
      description:
        "Housekeeping and health. `stats` reports counts; `consolidate` merges near-duplicates; "
        + "`prune` soft-archives stale low-importance entries; `promote` turns often-retrieved working "
        + "memories into insights; `clear_working` drops working memory; `prune_graph` removes stale "
        + "entities; `reflect` distils new insights (needs ANTHROPIC_API_KEY); `verify_anchors` checks Git freshness; `all` runs prune + promote.",
      inputSchema: {
        scope: SCOPE,
        action: z.enum([
          "stats",
          "consolidate",
          "prune",
          "promote",
          "clear_working",
          "prune_graph",
          "reflect",
          "verify_anchors",
          "all"
        ]).default("stats"),
        agent: z.string().optional().describe("clear_working and reflect only"),
        min_importance: z.number().min(0).max(1).optional().describe("prune/all: decayed-importance floor"),
        min_stale_days: z.number().int().min(1).optional().describe("prune/all: untouched days threshold"),
        min_access_count: z.number().int().min(1).max(100).optional().describe("promote/all: min retrievals"),
        max_age_days: z.number().int().min(1).optional().describe("prune_graph: max age for isolated nodes")
      }
    },
    async ({ scope, action, agent, min_importance, min_stale_days, min_access_count, max_age_days }) => {
      const target = store(scope);
      try {
        switch (action) {
          case "stats": {
            const stats = await target.getStats();
            const graph = await target.getGraphStats?.();
            return success(JSON.stringify({ ...stats, graph }, null, 2), { scope, stats, graph });
          }
          case "consolidate": {
            const result = await target.consolidate?.() ?? { consolidated: 0, created: null, archived: [] };
            return success(`Consolidated ${result.consolidated} memories.`, { scope, ...result });
          }
          case "prune": {
            const pruned = await target.pruneStale?.({
              minImportance: min_importance,
              minStaleDays: min_stale_days
            }) ?? [];
            return success(`Pruned ${pruned.length} memories.`, { scope, count: pruned.length, ids: pruned });
          }
          case "promote": {
            const promoted = await target.promoteWorking?.({ minAccessCount: min_access_count }) ?? [];
            return success(
              `Promoted ${promoted.length} working memories to insight.`,
              { scope, count: promoted.length, ids: promoted }
            );
          }
          case "clear_working": {
            const cleared = await target.clearWorking(agent ?? undefined);
            return success(`Cleared ${cleared} working memory entries.`, { scope, cleared });
          }
          case "prune_graph": {
            const result = await target.graphPrune?.(max_age_days) ?? { removedEntities: 0, removedEdges: 0 };
            return success(
              `Pruned ${result.removedEntities} entities and ${result.removedEdges} edges.`,
              { scope, ...result }
            );
          }
          case "reflect": {
            const insights = await target.reflect?.({ agent: agent ?? undefined }) ?? [];
            return success(JSON.stringify(insights, null, 2), { scope, count: insights.length, insights });
          }
          case "verify_anchors": {
            const report = await target.verifyAnchors?.() ?? {
              totalAnchored: 0, fresh: 0, drifted: 0, missing: 0, unavailable: 0, entries: []
            };
            return success(JSON.stringify(report, null, 2), { scope, report });
          }
          case "all": {
            const result = await target.runMaintenance?.({
              minImportance: min_importance,
              minStaleDays: min_stale_days,
              minAccessCount: min_access_count
            }) ?? { pruned: [], promoted: [] };
            return success(
              `Pruned ${result.pruned.length}, promoted ${result.promoted.length}.`,
              { scope, ...result }
            );
          }
        }
      } catch (error) { return failure(error); }
    }
  );
}
