import type { MemoryStoreEntry, MemoryType, AutoMaintenanceOptions } from "../memory/adapter.js";
import type { AnchorVerificationReport, MemoryAnchor } from "../memory/anchors.js";

/**
 * MemoryPort — abstraction over memory storage (file-based or MCP-backed).
 * Both FileAdapter and McpBackedAdapter implement this interface.
 */
export interface MemoryPort {
  remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number; anchors?: MemoryAnchor[] }
  ): Promise<MemoryStoreEntry>;

  recall(opts?: { type?: MemoryType; agent?: string; tags?: string[]; limit?: number; includeArchived?: boolean; includeStale?: boolean; touch?: boolean }): Promise<MemoryStoreEntry[]>;

  searchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number; includeStale?: boolean }): Promise<MemoryStoreEntry[]>;

  scoredSearchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number; includeStale?: boolean }): Promise<MemoryStoreEntry[]>;

  updateMemory(id: string, type: MemoryType, updates: { content?: string; tags?: string[]; importance?: number }): Promise<MemoryStoreEntry | null>;

  getStats(): Promise<{ total: number; byType: Record<string, number>; byAgent: Record<string, number> }>;

  forget(id: string, type: MemoryType): Promise<void>;

  clearWorking(agent?: string): Promise<number>;

  // ── Optional advanced methods (default fallbacks) ───────────────

  /** Entity-aware search: expand query with related entities */
  graphQuery?(query: string, opts?: { agent?: string; limit?: number; includeStale?: boolean }): Promise<MemoryStoreEntry[]>;

  /** Find relation path between two entities */
  graphFindPath?(from: string, to: string): Promise<{ from: string; relation: string; to: string }[]>;

  /** Explain why a memory was reachable for a question through the entity graph. */
  graphWhy?(memoryId: string, question: string): Promise<{ reachable: boolean; paths: Array<{ from: string; relation: string; to: string }[]>; entities: string[] }>;

  /** Entity graph statistics */
  getGraphStats?(): Promise<{ entityCount: number; edgeCount: number }>;

  /** Prune stale/isolated entities from the entity graph. */
  graphPrune?(maxAgeDays?: number): Promise<{ removedEntities: number; removedEdges: number }>;

  /** Rebuild the entity graph from every stored memory. */
  graphRebuild?(): Promise<{ entityCount: number; edgeCount: number; memoriesIndexed: number }>;

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

  /** Verify file anchors and report freshness. */
  verifyAnchors?(opts?: { includeArchived?: boolean; paths?: string[] }): Promise<AnchorVerificationReport>;
}

