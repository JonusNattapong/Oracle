import type { MemoryStoreEntry, MemoryType, AutoMaintenanceOptions } from "../memory/adapter.js";

/**
 * MemoryPort — abstraction over memory storage (file-based or MCP-backed).
 * Both FileAdapter and McpBackedAdapter implement this interface.
 */
export interface MemoryPort {
  remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number }
  ): Promise<MemoryStoreEntry>;

  recall(opts?: { type?: MemoryType; agent?: string; tags?: string[]; limit?: number; includeArchived?: boolean }): Promise<MemoryStoreEntry[]>;

  searchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }): Promise<MemoryStoreEntry[]>;

  scoredSearchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }): Promise<MemoryStoreEntry[]>;

  updateMemory(id: string, type: MemoryType, updates: { content?: string; tags?: string[]; importance?: number }): Promise<MemoryStoreEntry | null>;

  getStats(): Promise<{ total: number; byType: Record<string, number>; byAgent: Record<string, number> }>;

  forget(id: string, type: MemoryType): Promise<void>;

  clearWorking(agent?: string): Promise<number>;

  // ── Optional advanced methods (default fallbacks) ───────────────

  /** Entity-aware search: expand query with related entities */
  graphQuery?(query: string, opts?: { agent?: string; limit?: number }): Promise<MemoryStoreEntry[]>;

  /** Find relation path between two entities */
  graphFindPath?(from: string, to: string): Promise<{ from: string; relation: string; to: string }[]>;

  /** Entity graph statistics */
  getGraphStats?(): Promise<{ entityCount: number; edgeCount: number }>;

  /** Prune stale/isolated entities from the entity graph. */
  graphPrune?(maxAgeDays?: number): Promise<{ removedEntities: number; removedEdges: number }>;

  /** Renderable projection of the entity graph. */
  getGraphView?(opts?: { limit?: number; includeIsolated?: boolean }): Promise<import("../memory/entityGraph.js").GraphView>;

  /** One entity with its relations and mentioning memories. */
  getGraphEntity?(name: string): Promise<import("../memory/entityGraph.js").EntityDetail | null>;

  /** Entities ordered by connectedness. */
  listGraphEntities?(limit?: number): Promise<Array<import("../memory/entityGraph.js").Entity & { degree: number }>>;

  /** Merge near-duplicate memories by tag overlap */
  consolidate?(): Promise<{ consolidated: number; created: MemoryStoreEntry | null; archived: string[] }>;

  /** Prune stale low-importance memories */
  pruneStale?(opts?: { minImportance?: number; minStaleDays?: number }): Promise<string[]>;

  /** Promote working memories with high access count to insight */
  promoteWorking?(opts?: { minAccessCount?: number }): Promise<string[]>;

  /** Run both prune and promote */
  runMaintenance?(opts?: { minImportance?: number; minStaleDays?: number; minAccessCount?: number }): Promise<{ pruned: string[]; promoted: string[] }>;

  /** LLM-based insight synthesis */
  reflect?(opts?: { agent?: string }): Promise<{ content: string; tags: string[]; confidence: number; sourceIds: string[] }[]>;

  /** Start periodic maintenance on an interval. Returns a stop function. */
  startAutoMaintenance?(opts?: AutoMaintenanceOptions): () => void;

  /** Stop periodic maintenance. */
  stopAutoMaintenance?(): void;
}

