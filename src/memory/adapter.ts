import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { MemoryPort } from "../orchestrator/ports.js";
import { VectorStore } from "./vectorStore.js";
import { SQLiteMemoryBackend } from "./sqliteMemoryBackend.js";
import { EntityGraph } from "./entityGraph.js";
import { consolidateMemories, type ConsolidationResult } from "./consolidation.js";
import { pruneStaleMemories, promoteWorkingMemories, runMaintenance, type MaintenanceOptions, type MaintenanceResult } from "./maintenance.js";
import { reflectOnMemories, type Reflection } from "./reflect.js";
import type { RuntimeDatabase } from "../runtime/database.js";
import { checkAnchors, type AnchorStatus, type AnchorVerificationReport, type MemoryAnchor } from "./anchors.js";

/** Options for MemoryAdapter.startAutoMaintenance(). */
export interface AutoMaintenanceOptions {
  /** How often to run the maintenance cycle (ms). Default: 1 hour. */
  intervalMs?: number;
  /**
   * Run LLM-based reflection every N maintenance cycles.
   * 0 or undefined = never. Default: 4 (every ~4 hours with 1h interval).
   * Requires ANTHROPIC_API_KEY to do anything.
   */
  reflectEvery?: number;
  /**
   * Prune stale isolated entities from the graph every N maintenance cycles.
   * 0 or undefined = never. Default: 2 (every ~2 hours with 1h interval).
   */
  graphPruneEvery?: number;
  /** Max age (days) for isolated graph nodes before pruning. Default: 90. */
  graphMaxAgeDays?: number;
}

// ponytail: writes directly to .oracle-memory/ format — zero deps, no MCP needed.
// oracle-memory server reads the same files, so memory is shared transparently.

export type MemoryType = "fact" | "insight" | "chunk" | "working";

export interface MemoryStoreEntry {
  id: string;
  ts: string;
  agent: string;
  type: MemoryType;
  content: string;
  tags: string[];
  meta: Record<string, unknown>;
  ttl?: number;
  source?: string;
  importance?: number;
  archived?: boolean;
  consolidatedBy?: string;
  accessCount: number;
  lastAccessed: string;
  decayRate: number;
  /** File anchors are persisted; statuses are computed on read and never persisted. */
  anchors?: MemoryAnchor[];
  anchorStatus?: AnchorStatus[];
}

interface AnchorIndexRecord {
  id: string;
  type: MemoryType;
  anchors?: MemoryAnchor[];
  deleted?: boolean;
}

const DATA_DIR = ".oracle-memory";
const TYPE_DIR: Record<MemoryType, string> = {
  fact: "facts",
  insight: "insights",
  chunk: "chunks",
  working: "working",
};
const USE_OLLAMA = process.env.ORACLE_USE_OLLAMA === "1" || process.env.ORACLE_USE_OLLAMA === "true";

function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const micros = String(now.getMilliseconds()).padStart(3, "0") + "000";
  const rand = crypto.randomBytes(6).toString("hex");
  return `${date}-${time}-${micros}-${rand}`;
}

/** Cheap canonical form used to prevent exact duplicate writes without an LLM. */
function canonicalContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}

export class MemoryAdapter implements MemoryPort {
  private vectors: VectorStore;  // Legacy fallback
  private vectorsLoaded = false;
  private sqliteBackend: SQLiteMemoryBackend | null = null;
  private entityGraph: EntityGraph;
  private anchorIndexWrite: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string, private readonly dataDirectory = DATA_DIR) {
    this.vectors = new VectorStore(rootDir, dataDirectory);
    this.entityGraph = new EntityGraph(rootDir, dataDirectory);
  }

  /** Initialize with SQLite backend if available. */
  initWithDatabase(db: RuntimeDatabase['connection']): void {
    if (db) {
      const vectorsJsonPath = path.join(this.rootDir, this.dataDirectory, "vectors.json");
      this.sqliteBackend = new SQLiteMemoryBackend(db, vectorsJsonPath);
      this.sqliteBackend.initialize().catch(() => {});
    }
  }

  private dataDir(): string {
    return path.join(this.rootDir, this.dataDirectory);
  }

  private anchorIndexPath(): string {
    return path.join(this.dataDir(), "anchors.ndjson");
  }

  private queueAnchorIndex(record: AnchorIndexRecord): void {
    this.anchorIndexWrite = this.anchorIndexWrite.then(async () => {
      await this.ensureDirs();
      await fs.appendFile(this.anchorIndexPath(), `${JSON.stringify(record)}\n`, "utf8");
    }).catch(() => {});
  }

  private async readAnchorIndex(): Promise<AnchorIndexRecord[] | null> {
    try {
      const lines = (await fs.readFile(this.anchorIndexPath(), "utf8")).split("\n").filter(Boolean);
      const latest = new Map<string, AnchorIndexRecord>();
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as AnchorIndexRecord;
          latest.set(record.id, record);
        } catch { /* skip corrupt index rows */ }
      }
      return [...latest.values()].filter((record) => !record.deleted && record.anchors?.length);
    } catch { return null; }
  }

  private typeDir(type: MemoryType): string {
    return path.join(this.dataDir(), TYPE_DIR[type]);
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.dataDir(), { recursive: true });
    for (const dir of Object.values(TYPE_DIR)) {
      await fs.mkdir(path.join(this.dataDir(), dir), { recursive: true });
    }
  }

  private async ensureVectors(): Promise<void> {
    if (!USE_OLLAMA || this.vectorsLoaded) return;
    await this.vectors.load();
    this.vectorsLoaded = true;
  }

  private filePath(type: MemoryType, id: string): string {
    return path.join(this.typeDir(type), `${id}.json`);
  }

  private async readEntry(type: MemoryType, id: string): Promise<MemoryStoreEntry | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(type, id), "utf8")) as MemoryStoreEntry;
    } catch { return null; }
  }

  private async writeEntry(entry: MemoryStoreEntry): Promise<void> {
    const fp = this.filePath(entry.type, entry.id);
    const tmp = `${fp}.tmp`;
    const { anchorStatus: _anchorStatus, ...persisted } = entry;
    await fs.writeFile(tmp, JSON.stringify(persisted, null, 2), "utf8");
    await fs.rename(tmp, fp);
  }

  private anchorWeight(entry: MemoryStoreEntry): number {
    if (!entry.anchorStatus?.length) return 1;
    if (entry.anchorStatus.some((status) => status.state === "missing")) return 0;
    if (entry.anchorStatus.some((status) => status.state === "drifted")) return 0.5;
    return 1;
  }

  private async attachAnchorStatuses(entries: MemoryStoreEntry[], includeStale: boolean, anchorPaths?: string[]): Promise<MemoryStoreEntry[]> {
    const pathSet = anchorPaths?.length ? new Set(anchorPaths.map((value) => value.replaceAll("\\", "/"))) : undefined;
    const anchored = entries.filter((entry) => entry.anchors?.length && (!pathSet || entry.anchors.some((anchor) => pathSet.has(anchor.path))));
    if (anchored.length === 0) return entries;
    const anchors = anchored.flatMap((entry) => entry.anchors ?? []);
    const statuses = await checkAnchors(this.rootDir, anchors);
    const statusMap = new Map(statuses.map((status, index) => {
      const anchor = anchors[index];
      return [`${anchor.path}\0${anchor.commit}\0${anchor.blobSha ?? ""}`, status];
    }));
    return entries
      .map((entry) => {
        if (!entry.anchors?.length) return entry;
        const anchorStatus = entry.anchors.map((anchor) => {
          if (pathSet && !pathSet.has(anchor.path)) return undefined;
          return statusMap.get(`${anchor.path}\0${anchor.commit}\0${anchor.blobSha ?? ""}`);
        }).filter((status): status is AnchorStatus => Boolean(status));
        return { ...entry, anchorStatus };
      })
      .filter((entry) => includeStale || !entry.anchorStatus?.some((status) => status.state === "missing"));
  }

  /** Token overlap + durable-memory signals, deliberately zero-cost. */
  private lexicalScore(entry: MemoryStoreEntry, terms: string[]): number {
    const haystack = `${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
    const matched = terms.filter((term) => haystack.includes(term));
    if (!matched.length) return 0;
    const coverage = matched.length / terms.length;
    const tagBonus = matched.filter((term) => entry.tags.some((tag) => tag.includes(term))).length * 0.12;
    return (coverage * 0.7) + ((entry.importance ?? 0.5) * 0.2) + (Math.log1p(entry.accessCount ?? 0) * 0.04) + tagBonus;
  }

  async remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number; anchors?: MemoryAnchor[] }
  ): Promise<MemoryStoreEntry> {
    await this.ensureDirs();
    const normalizedContent = canonicalContent(content);
    const existing = await this.recall({ type, limit: 10_000, includeArchived: false, touch: false });
    const duplicate = existing.find((entry) => canonicalContent(entry.content) === normalizedContent);
    if (duplicate) return duplicate;
    const now = new Date().toISOString();
    const entry: MemoryStoreEntry = {
      id: generateId(),
      ts: now,
      agent,
      type,
      content,
      tags: normalizeTags(opts?.tags ?? []),
      meta: opts?.meta ?? {},
      importance: opts?.importance ?? 0.5,
      accessCount: 0,
      lastAccessed: now,
      decayRate: 0.01,
      ...(opts?.anchors?.length ? { anchors: opts.anchors } : {}),
    };
    await this.writeEntry(entry);
    if (entry.anchors?.length) this.queueAnchorIndex({ id: entry.id, type: entry.type, anchors: entry.anchors });

    // Fire-and-forget indexing — never blocks remember
    if (this.sqliteBackend) {
      // Index both vector (semantic) and BM25 (lexical)
      this.sqliteBackend.indexMemory(entry.id, content).catch(() => {});
      this.sqliteBackend.indexContent(entry.id, content);
    } else if (USE_OLLAMA) {
      // Fallback: legacy JSON-based vector store
      this.ensureVectors().then(() => this.vectors.index(entry.id, content)).catch(() => {});
    }
    // Entity graph indexing
    this.entityGraph.indexMemory(entry.id, content, entry.tags).catch(() => {});
    return entry;
  }

  async recall(opts?: { type?: MemoryType; agent?: string; tags?: string[]; limit?: number; includeArchived?: boolean; includeStale?: boolean; anchorPaths?: string[]; touch?: boolean }): Promise<MemoryStoreEntry[]> {
    const type = opts?.type;
    const agent = opts?.agent;
    const tags = opts?.tags;
    const limit = opts?.limit ?? 20;
    const includeArchived = opts?.includeArchived ?? false;
    const includeStale = opts?.includeStale ?? false;
    // Bulk/internal reads (maintenance, consolidation, stats) pass touch:false
    // so loading an entry for inspection doesn't itself reset its staleness clock.
    const touch = opts?.touch ?? true;
    const dirs = type
      ? [this.typeDir(type)]
      : Object.values(TYPE_DIR).map((d) => path.join(this.dataDir(), d));
    const entries: MemoryStoreEntry[] = [];
    for (const dir of dirs) {
      try {
        const files = (await fs.readdir(dir)).sort();
        const candidates = files.slice(-(limit * 4)).filter((file) => file.endsWith(".json"));
        const loaded = await Promise.all(candidates.map(async (file) => {
          try { return JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as MemoryStoreEntry; }
          catch { return null; }
        }));
        for (const entry of loaded) {
          if (!entry) continue;
          if (entry.archived && !includeArchived) continue;
          if (agent && entry.agent !== agent) continue;
          if (tags && !tags.some((t) => entry.tags.includes(t))) continue;
          entries.push(entry);
        }
      } catch { /* dir not ready */ }
    }
    const freshEntries = await this.attachAnchorStatuses(entries, includeStale, opts?.anchorPaths);
    const results = freshEntries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
    // Track access — fire-and-forget so recall never blocks
    if (touch) {
      for (const e of results) {
        this.touchEntry(e).catch(() => {});
      }
    }
    return results;
  }

  private async touchEntry(entry: MemoryStoreEntry): Promise<void> {
    entry.accessCount = (entry.accessCount ?? 0) + 1;
    entry.lastAccessed = new Date().toISOString();
    await this.writeEntry(entry).catch(() => {});
  }

  private recencyWeightedScore(semanticScore: number, entry: MemoryStoreEntry): number {
    const age = Date.now() - new Date(entry.lastAccessed ?? entry.ts).getTime();
    const days = age / 86400000;
    const importance = entry.importance ?? 0.5;
    const accessCount = entry.accessCount ?? 0;
    const decayRate = entry.decayRate ?? 0.01;
    const recencyBoost = Math.exp(-days * decayRate);
    const freqBoost = Math.log1p(accessCount) * 0.1;
    return (semanticScore * 0.6) + (importance * 0.2) + (recencyBoost * 0.15) + (freqBoost * 0.05);
  }

  async searchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number; includeStale?: boolean }): Promise<MemoryStoreEntry[]> {
    const limit = opts?.limit ?? 50;
    const q = query.toLowerCase();

    // Try hybrid search via SQLite backend (semantic + lexical with RRF)
    if (this.sqliteBackend && q.length > 0) {
      try {
        const hits = await this.sqliteBackend.search(query, limit * 2);
        if (hits.length > 0) {
          const ids = new Map(hits.map((h) => [h.memoryId, h.score]));
          const all = await this.recall({ type: opts?.type, agent: opts?.agent, limit: 10_000, includeStale: opts?.includeStale });
          const scored = all
            .filter((e) => ids.has(e.id))
            .map((e) => ({ entry: e, score: ids.get(e.id)! * this.anchorWeight(e) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
          return scored.map((s) => s.entry);
        }
      } catch {
        // Fall through to keyword-only search
      }
    }

    // Fallback: keyword-only (BM25 via SQLite or lexical score)
    const terms = queryTerms(query);
    const entries = await this.recall({ type: opts?.type, agent: opts?.agent, limit: Math.max(limit * 4, 100), includeStale: opts?.includeStale, touch: false });
    return entries
      .map((entry) => ({ entry, score: this.lexicalScore(entry, terms) * this.anchorWeight(entry) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((hit) => hit.entry);
  }

  /**
   * scoredSearchMemories — recency-weighted semantic search.
   * Uses the same vector index as searchMemories, then re-ranks results
   * with recency, frequency, and importance factored in.
   */
  async scoredSearchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number; includeStale?: boolean }): Promise<MemoryStoreEntry[]> {
    const limit = opts?.limit ?? 50;
    const q = query.toLowerCase();

    if (this.sqliteBackend && q.length > 0) {
      try {
        const hits = await this.sqliteBackend.search(query, limit * 4);
        if (hits.length > 0) {
          const ids = new Map(hits.map((h) => [h.memoryId, h.score]));
          const all = await this.recall({ type: opts?.type, agent: opts?.agent, limit: 10_000, includeStale: opts?.includeStale });
          const scored = all
            .filter((e) => ids.has(e.id))
            .map((e) => ({
              entry: e,
              score: this.recencyWeightedScore(ids.get(e.id)!, e) * this.anchorWeight(e),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
          // Track access for scored results too
          for (const s of scored) {
            this.touchEntry(s.entry).catch(() => {});
          }
          return scored.map((s) => s.entry);
        }
      } catch {
        // Fall through to keyword-only search
      }
    }

    // Fallback: keyword + recency sort
    const terms = queryTerms(query);
    const entries = await this.recall({ type: opts?.type, agent: opts?.agent, limit: Math.max(limit * 4, 100), includeStale: opts?.includeStale, touch: false });
    return entries
      .map((entry) => ({ entry, score: this.lexicalScore(entry, terms) * this.anchorWeight(entry) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => this.recencyWeightedScore(b.score, b.entry) - this.recencyWeightedScore(a.score, a.entry))
      .slice(0, limit)
      .map((hit) => hit.entry);
  }

  async updateMemory(id: string, type: MemoryType, updates: { content?: string; tags?: string[]; importance?: number }): Promise<MemoryStoreEntry | null> {
    const entry = await this.readEntry(type, id);
    if (!entry) return null;
    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.tags !== undefined) entry.tags = updates.tags;
    if (updates.importance !== undefined) entry.importance = updates.importance;
    await this.writeEntry(entry);
    if (entry.anchors?.length) this.queueAnchorIndex({ id: entry.id, type: entry.type, anchors: entry.anchors });
    if (USE_OLLAMA && updates.content !== undefined) {
      this.ensureVectors().then(() => this.vectors.index(id, entry.content)).catch(() => {});
    }
    return entry;
  }

  async getStats(): Promise<{ total: number; byType: Record<string, number>; byAgent: Record<string, number> }> {
    const all = await this.recall({ limit: 10_000, touch: false });
    const byType: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const e of all) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      byAgent[e.agent] = (byAgent[e.agent] ?? 0) + 1;
    }
    return { total: all.length, byType, byAgent };
  }

  /** Verify every persisted file anchor in one batch and return a compact report. */
  async verifyAnchors(opts?: { includeArchived?: boolean; paths?: string[] }): Promise<AnchorVerificationReport> {
    const indexed = await this.readAnchorIndex();
    if (indexed?.length) {
      const pathSet = opts?.paths?.length ? new Set(opts.paths.map((value) => value.replaceAll("\\", "/"))) : undefined;
      const selected = indexed.filter((record) => !pathSet || record.anchors?.some((anchor) => pathSet.has(anchor.path)));
      const anchors = selected.flatMap((record) => record.anchors ?? []);
      const statuses = await checkAnchors(this.rootDir, anchors);
      const statusMap = new Map(statuses.map((status, index) => {
        const anchor = anchors[index];
        return [`${anchor.path}\0${anchor.commit}\0${anchor.blobSha ?? ""}`, status];
      }));
      const report: AnchorVerificationReport = { totalAnchored: 0, fresh: 0, drifted: 0, missing: 0, unavailable: 0, entries: [] };
      for (const record of selected) {
        const entryStatuses = (record.anchors ?? []).map((anchor) => statusMap.get(`${anchor.path}\0${anchor.commit}\0${anchor.blobSha ?? ""}`)!).filter(Boolean);
        report.totalAnchored += entryStatuses.length;
        for (const status of entryStatuses) report[status.state]++;
        report.entries.push({ id: record.id, type: record.type, statuses: entryStatuses });
      }
      return report;
    }
    const all = await this.recall({
      limit: 100_000,
      includeArchived: opts?.includeArchived ?? true,
      includeStale: true,
      anchorPaths: opts?.paths,
      touch: false,
    });
    const anchored = all.filter((entry) => entry.anchors?.length && entry.anchorStatus?.length);
    const report: AnchorVerificationReport = {
      totalAnchored: anchored.reduce((sum, entry) => sum + (entry.anchorStatus?.length ?? 0), 0),
      fresh: 0,
      drifted: 0,
      missing: 0,
      unavailable: 0,
      entries: [],
    };
    for (const entry of anchored) {
      const statuses = entry.anchorStatus ?? [];
      for (const status of statuses) report[status.state]++;
      report.entries.push({ id: entry.id, type: entry.type, statuses });
      if (entry.anchors?.length) this.queueAnchorIndex({ id: entry.id, type: entry.type, anchors: entry.anchors });
    }
    return report;
  }

  async forget(id: string, type: MemoryType): Promise<void> {
    try {
      await fs.unlink(this.filePath(type, id));
    } catch { /* ignore */ }
    this.queueAnchorIndex({ id, type, deleted: true });
    if (this.sqliteBackend) {
      this.sqliteBackend.remove(id);
    } else if (USE_OLLAMA) {
      this.vectors.remove(id).catch(() => {});
    }
    this.entityGraph.removeMemory(id).catch(() => {});
  }

  async clearWorking(agent?: string): Promise<number> {
    let count = 0;
    const dir = this.typeDir("working");
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        if (agent) {
          try {
            const entry = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as MemoryStoreEntry;
            if (entry.agent !== agent) continue;
          } catch { continue; }
        }
        const id = file.replace(".json", "");
        await fs.unlink(path.join(dir, file));
        this.queueAnchorIndex({ id, type: "working", deleted: true });
        if (USE_OLLAMA) this.vectors.remove(id).catch(() => {});
        this.entityGraph.removeMemory(id).catch(() => {});
        count++;
      }
    } catch { /* ignore */ }
    return count;
  }

  // ── Entity graph ─────────────────────────────────────────────────

  /** Entity-aware search: expand query with related entities. */
  async graphQuery(query: string, opts?: { agent?: string; limit?: number; includeStale?: boolean }): Promise<MemoryStoreEntry[]> {
    const { entities, related } = await this.entityGraph.expandQuery(query);
    const entityNames = new Set([...entities, ...related.map((r) => r.name)]);
    const limit = opts?.limit ?? 20;

    // Search by expanded terms
    const expandedTerms = [query, ...entityNames].join(" ");
    const results = await this.scoredSearchMemories(expandedTerms, { agent: opts?.agent, limit, includeStale: opts?.includeStale });
    return results.slice(0, limit);
  }

  /** Find relation path between two entities. */
  async graphFindPath(from: string, to: string): Promise<import("./entityGraph.js").PathHop[]> {
    return this.entityGraph.findPath(from, to);
  }

  async graphWhy(memoryId: string, question: string): Promise<{ reachable: boolean; paths: import("./entityGraph.js").PathHop[][]; entities: string[] }> {
    const targetEntities = await this.entityGraph.entitiesForMemory(memoryId);
    const { entities: questionEntities } = await this.entityGraph.expandQuery(question);
    const paths: import("./entityGraph.js").PathHop[][] = [];
    for (const from of questionEntities) {
      for (const to of targetEntities) {
        if (from === to) paths.push([]);
        else {
          const path = await this.entityGraph.findPath(from, to);
          if (path.length) paths.push(path);
        }
      }
    }
    return { reachable: paths.length > 0, paths, entities: targetEntities };
  }

  /** Entity graph statistics. */
  async getGraphStats(): Promise<{ entityCount: number; edgeCount: number }> {
    return this.entityGraph.getStats();
  }

  /**
   * Rebuilds the entity graph from every stored memory.
   *
   * Indexing is incremental, so entities extracted under older rules survive
   * until their memory is rewritten. This is what applies an extractor change
   * to memories that are already on disk.
   */
  async graphRebuild(): Promise<{
    entityCount: number;
    edgeCount: number;
    memoriesIndexed: number;
  }> {
    const memories = await this.recall({ limit: 100_000, includeArchived: true });
    return this.entityGraph.rebuild(
      memories.map((entry) => ({ id: entry.id, content: entry.content, tags: entry.tags }))
    );
  }

  /** Renderable graph projection for `oracle memory graph`. */
  async getGraphView(opts?: { limit?: number; includeIsolated?: boolean }): Promise<import("./entityGraph.js").GraphView> {
    return this.entityGraph.toGraphView(opts);
  }

  /** One entity with its relations and mentioning memories. */
  async getGraphEntity(name: string): Promise<import("./entityGraph.js").EntityDetail | null> {
    return this.entityGraph.getEntity(name);
  }

  /** Entities ordered by connectedness. */
  async listGraphEntities(limit?: number): Promise<Array<import("./entityGraph.js").Entity & { degree: number }>> {
    return this.entityGraph.listEntities(limit);
  }

  /** Prune stale/isolated entities from the graph. */
  async graphPrune(maxAgeDays?: number): Promise<{ removedEntities: number; removedEdges: number }> {
    return this.entityGraph.pruneGraph(maxAgeDays);
  }

  // ── Consolidation ───────────────────────────────────────────────

  /** Merge near-duplicate memories by tag overlap. */
  async consolidate(): Promise<ConsolidationResult> {
    const all = await this.recall({ limit: 10_000, touch: false });

    const archiveFn = async (id: string, consolidatedBy: string): Promise<boolean> => {
      for (const t of Object.values(TYPE_DIR) as string[]) {
        try {
          const fp = path.join(this.dataDir(), t, `${id}.json`);
          const raw = await fs.readFile(fp, "utf8").catch(() => null);
          if (!raw) continue;
          const entry = JSON.parse(raw) as MemoryStoreEntry;
          if (entry.id !== id) continue;
          entry.archived = true;
          entry.consolidatedBy = consolidatedBy;
          await this.writeEntry(entry);
          return true;
        } catch { /* try next dir */ }
      }
      return false;
    };

    const saveFn = async (entry: MemoryStoreEntry): Promise<MemoryStoreEntry> => {
      await this.writeEntry(entry);
      return entry;
    };

    return consolidateMemories(all, saveFn, archiveFn);
  }

  // ── Maintenance ─────────────────────────────────────────────────

  /** Prune stale low-importance memories. */
  async pruneStale(opts?: MaintenanceOptions): Promise<string[]> {
    const all = await this.recall({ limit: 10_000, touch: false });
    const saveFn = async (entry: MemoryStoreEntry): Promise<void> => {
      await this.writeEntry(entry);
    };
    return pruneStaleMemories(all, opts, saveFn);
  }

  /** Promote working memories with high access count to insight. */
  async promoteWorking(opts?: MaintenanceOptions): Promise<string[]> {
    const all = await this.recall({ limit: 10_000, touch: false });
    const saveFn = async (entry: MemoryStoreEntry): Promise<void> => {
      await this.writeEntry(entry);
    };
    const deleteFn = async (id: string, type: string): Promise<void> => {
      await this.forget(id, type as MemoryType);
    };
    return promoteWorkingMemories(all, opts, saveFn, deleteFn);
  }

  /** Run both prune and promote in sequence. */
  async runMaintenance(opts?: MaintenanceOptions): Promise<MaintenanceResult> {
    const all = await this.recall({ limit: 10_000, touch: false });
    const saveFn = async (entry: MemoryStoreEntry): Promise<void> => {
      await this.writeEntry(entry);
    };
    const deleteFn = async (id: string, type: string): Promise<void> => {
      await this.forget(id, type as MemoryType);
    };
    return runMaintenance(all, opts, saveFn, deleteFn);
  }

  // ── Reflection ──────────────────────────────────────────────────

  /** LLM-based insight synthesis from related memories. Requires ANTHROPIC_API_KEY. */
  async reflect(opts?: { agent?: string }): Promise<Reflection[]> {
    const all = await this.recall({ limit: 200, agent: opts?.agent, touch: false });
    return reflectOnMemories(all);
  }

  // ── Auto-Maintenance Scheduling ─────────────────────────────────

  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceCycle = 0;

  /**
   * Start periodic maintenance on an interval.
   *
   * Each cycle runs: consolidate → prune + promote → (optionally) graph prune → (optionally) reflect.
   * Graph pruning and reflection are run at a reduced frequency (every N cycles)
   * because they are more expensive operations.
   *
   * @returns A function to stop the scheduled maintenance.
   */
  startAutoMaintenance(opts?: AutoMaintenanceOptions): () => void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
    }

    const intervalMs = opts?.intervalMs ?? 3_600_000;
    const reflectEvery = opts?.reflectEvery ?? 4;
    const graphPruneEvery = opts?.graphPruneEvery ?? 2;
    const graphMaxAgeDays = opts?.graphMaxAgeDays ?? 90;

    const run = async () => {
      this.maintenanceCycle++;
      try {
        // ── Consolidate ────────────────────────────────────────────
        const consolidateResult = await this.consolidate();
        if (consolidateResult.consolidated > 0) {
          console.error(`[auto-maintenance] consolidated ${consolidateResult.consolidated} memories`);
        }

        // ── Prune + promote ────────────────────────────────────────
        const maintResult = await this.runMaintenance();
        if (maintResult.pruned.length > 0) {
          console.error(`[auto-maintenance] pruned ${maintResult.pruned.length} stale memories`);
        }
        if (maintResult.promoted.length > 0) {
          console.error(`[auto-maintenance] promoted ${maintResult.promoted.length} memories to insight`);
        }

        // ── Graph pruning (every N cycles) ─────────────────────────
        if (graphPruneEvery > 0 && this.maintenanceCycle % graphPruneEvery === 0) {
          const graphResult = await this.graphPrune(graphMaxAgeDays);
          if (graphResult.removedEntities > 0 || graphResult.removedEdges > 0) {
            console.error(`[auto-maintenance] pruned graph: ${graphResult.removedEntities} entities, ${graphResult.removedEdges} edges`);
          }
        }

        // ── Reflection (every N cycles) ────────────────────────────
        if (reflectEvery > 0 && this.maintenanceCycle % reflectEvery === 0) {
          const reflections = await this.reflect();
          if (reflections.length > 0) {
            console.error(`[auto-maintenance] generated ${reflections.length} new insights via reflection`);
          }
        }
      } catch (err) {
        console.error("[auto-maintenance] error:", err);
      }
    };

    // Run once immediately, then on the interval
    run();
    this.maintenanceTimer = setInterval(run, intervalMs);
    // Maintenance must not keep short-lived MCP stdio processes alive after
    // their client disconnects; the transport itself owns process lifetime.
    this.maintenanceTimer.unref();

    return () => this.stopAutoMaintenance();
  }

  /** Stop the periodic maintenance if it was started. */
  stopAutoMaintenance(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
  }
}
