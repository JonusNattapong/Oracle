import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MemoryPort } from "../../orchestrator/ports.js";
import { OracleError, serializeOracleError } from "../../errors.js";
import { buildWiki, getWikiPage, listWikiTopics } from "../../wiki/compile.js";

function success(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>
  };
}

export function registerMemoryTools(
  server: McpServer,
  deps: { memory: MemoryPort; globalMemory: MemoryPort; workspaceRoot: string }
): void {
  const { memory, globalMemory } = deps;

  server.registerTool(
    "oracle_memory_remember",
    {
      title: "Save Memory",
      description: "Save a memory (project by default, global for cross-project knowledge).",
      inputSchema: {
        scope: z.enum(["project", "global"]).default("project"),
        agent: z.string().min(1),
        type: z.enum(["fact", "insight", "chunk", "working"]),
        content: z.string().min(1).max(20_000),
        tags: z.array(z.string().min(1)).max(50).optional(),
        importance: z.number().min(0).max(1).optional()
      }
    },
    async ({ scope, agent, type, content, tags, importance }) => {
      try {
        const entry = await (scope === "global" ? globalMemory : memory).remember(agent, type, content, { tags, importance });
        return success(`Saved ${scope} memory ${entry.id}.`, { scope, memory: entry });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_list",
    {
      title: "List Memory",
      description: "List memory entries (project or global).",
      inputSchema: { scope: z.enum(["project", "global"]).default("project"), agent: z.string().optional(), type: z.enum(["fact", "insight", "chunk", "working"]).optional(), limit: z.number().int().min(1).max(100).default(10) }
    },
    async ({ scope, agent, type, limit }) => {
      try {
        const entries = await (scope === "global" ? globalMemory : memory).recall({ type, agent: agent ?? undefined, limit });
        return success(JSON.stringify(entries, null, 2), { scope, entries });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_search",
    {
      title: "Search Memory",
      description: "Search memory by keyword.",
      inputSchema: { scope: z.enum(["project", "global"]).default("project"), query: z.string().min(1), agent: z.string().optional(), type: z.enum(["fact", "insight", "chunk", "working"]).optional(), limit: z.number().int().min(1).max(200).default(20) }
    },
    async ({ scope, query, agent, type, limit }) => {
      try {
        const entries = await (scope === "global" ? globalMemory : memory).searchMemories(query, { type: type as any, agent: agent ?? undefined, limit });
        return success(JSON.stringify(entries, null, 2), { scope, count: entries.length, entries });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_update",
    {
      title: "Update Memory",
      description: "Update content, tags, or importance of a memory entry.",
      inputSchema: { scope: z.enum(["project", "global"]).default("project"), id: z.string(), type: z.enum(["fact", "insight", "chunk", "working"]), content: z.string().optional(), tags: z.array(z.string()).optional(), importance: z.number().min(0).max(1).optional() }
    },
    async ({ scope, id, type, content, tags, importance }) => {
      try {
        const updated = await (scope === "global" ? globalMemory : memory).updateMemory(id, type as any, { content, tags, importance });
        if (!updated) return failure(new Error("Memory not found"));
        return success(JSON.stringify(updated, null, 2), { scope, memory: updated });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_stats",
    {
      title: "Memory Stats",
      description: "Memory counts by type and agent.",
      inputSchema: { scope: z.enum(["project", "global"]).default("project") }
    },
    async ({ scope }) => {
      try {
        const stats = await (scope === "global" ? globalMemory : memory).getStats();
        return success(JSON.stringify(stats, null, 2), { scope, stats });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_clear",
    {
      title: "Clear Memory",
      description: "Clear working memory.",
      inputSchema: { scope: z.enum(["project", "global"]).default("project"), agent: z.string().optional() }
    },
    async ({ scope, agent }) => {
      try {
        const count = await (scope === "global" ? globalMemory : memory).clearWorking(agent ?? undefined);
        return success(`Cleared ${count} working memory entries.`, { scope, cleared: count });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_scored_search",
    {
      title: "Scored Memory Search",
      description: "Ranked memory search with recency-weighted scoring.",
      inputSchema: {
        query: z.string().min(1),
        agent: z.string().optional(),
        type: z.enum(["fact", "insight", "chunk", "working"]).optional(),
        limit: z.number().int().min(1).max(200).default(20)
      }
    },
    async ({ query, agent, type, limit }) => {
      try {
        const entries = await memory.scoredSearchMemories(query, { agent: agent ?? undefined, type: type as any, limit });
        return success(JSON.stringify(entries, null, 2), { count: entries.length, entries });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_graph_query",
    {
      title: "Entity Graph Search",
      description: "Entity-aware search — expands query with related graph entities.",
      inputSchema: {
        query: z.string().min(1),
        agent: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(20)
      }
    },
    async ({ query, agent, limit }) => {
      try {
        const entries = await memory.graphQuery?.(query, { agent: agent ?? undefined, limit }) ?? [];
        return success(JSON.stringify(entries, null, 2), { count: entries.length, entries });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_graph_path",
    {
      title: "Entity Relationship Path",
      description: "Shortest path between two entities in the knowledge graph.",
      inputSchema: {
        from: z.string().min(1),
        to: z.string().min(1)
      }
    },
    async ({ from, to }) => {
      try {
        const path = await memory.graphFindPath?.(from, to) ?? [];
        return success(JSON.stringify(path, null, 2), { hops: path.length, path });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_graph_stats",
    {
      title: "Entity Graph Stats",
      description: "Knowledge-graph entity and edge counts.",
      inputSchema: {}
    },
    async () => {
      try {
        const stats = await memory.getGraphStats?.() ?? { entityCount: 0, edgeCount: 0 };
        return success(JSON.stringify(stats, null, 2), { stats });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_graph_prune",
    {
      title: "Prune Entity Graph",
      description: "Prune stale isolated entities and orphaned edges from the graph.",
      inputSchema: {
        max_age_days: z.number().int().min(1).optional().describe("Max age in days for isolated nodes (default 90)")
      }
    },
    async ({ max_age_days }) => {
      try {
        const result = await memory.graphPrune?.(max_age_days) ?? { removedEntities: 0, removedEdges: 0 };
        return success(`Pruned ${result.removedEntities} entities and ${result.removedEdges} edges.`, { ...result });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_consolidate",
    {
      title: "Consolidate Memories",
      description: "Merge near-duplicate memories with overlapping tags.",
      inputSchema: {}
    },
    async () => {
      try {
        const result = await memory.consolidate?.() ?? { consolidated: 0, created: null, archived: [] };
        return success(JSON.stringify(result, null, 2), { ...result });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_prune",
    {
      title: "Prune Stale Memories",
      description: "Soft-archive stale low-importance memories (recoverable).",
      inputSchema: {
        min_importance: z.number().min(0).max(1).optional().describe("Decayed-importance floor (default 0.2)"),
        min_stale_days: z.number().int().min(1).optional().describe("Untouched days threshold (default 30)")
      }
    },
    async ({ min_importance, min_stale_days }) => {
      try {
        const pruned = await memory.pruneStale?.({ minImportance: min_importance, minStaleDays: min_stale_days }) ?? [];
        return success(`Pruned ${pruned.length} memories.`, { count: pruned.length, ids: pruned });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_promote",
    {
      title: "Promote Working Memories",
      description: "Promote working memories with 3+ retrievals into durable insights.",
      inputSchema: {
        min_access_count: z.number().int().min(1).max(100).optional().describe("Min retrievals to promote (default 3)")
      }
    },
    async ({ min_access_count }) => {
      try {
        const promoted = await memory.promoteWorking?.({ minAccessCount: min_access_count }) ?? [];
        return success(`Promoted ${promoted.length} working memories to insight.`, { count: promoted.length, ids: promoted });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_maintenance",
    {
      title: "Run Memory Maintenance",
      description: "Run prune + promote in one call.",
      inputSchema: {
        min_importance: z.number().min(0).max(1).optional(),
        min_stale_days: z.number().int().min(1).optional(),
        min_access_count: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ min_importance, min_stale_days, min_access_count }) => {
      try {
        const result = await memory.runMaintenance?.({ minImportance: min_importance, minStaleDays: min_stale_days, minAccessCount: min_access_count }) ?? { pruned: [], promoted: [] };
        return success(`Pruned ${result.pruned.length}, promoted ${result.promoted.length}.`, { ...result });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_reflect",
    {
      title: "Memory Reflection",
      description: "LLM insight synthesis: cluster related memories, distill new insights. Requires ANTHROPIC_API_KEY.",
      inputSchema: {
        agent: z.string().optional().describe("Agent name for the reflection")
      }
    },
    async ({ agent }) => {
      try {
        const insights = await memory.reflect?.({ agent: agent ?? undefined }) ?? [];
        return success(JSON.stringify(insights, null, 2), { count: insights.length, insights });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_wiki_build",
    {
      title: "Build Memory Wiki",
      description: "Compile facts/insights into topic-grouped wiki pages.",
      inputSchema: {}
    },
    async () => {
      try {
        const result = await buildWiki(memory, deps.workspaceRoot);
        return success(`Compiled ${result.topics.length} topic(s).`, { ...result });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_wiki_list",
    {
      title: "List Wiki Topics",
      description: "List compiled wiki topics.",
      inputSchema: {}
    },
    async () => {
      try {
        const topics = await listWikiTopics(deps.workspaceRoot);
        return success(JSON.stringify(topics, null, 2), { topics });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_memory_wiki_get",
    {
      title: "Get Wiki Page",
      description: "Read a compiled wiki page. Build first if missing.",
      inputSchema: { topic: z.string().min(1) }
    },
    async ({ topic }) => {
      try {
        const page = await getWikiPage(deps.workspaceRoot, topic);
        if (!page) throw new OracleError("ORACLE_INVALID_REQUEST", `Wiki topic not found: ${topic}`, "Run oracle_memory_wiki_build or oracle_memory_wiki_list.");
        return success(page, { topic });
      } catch (error) { return failure(error); }
    }
  );
}
