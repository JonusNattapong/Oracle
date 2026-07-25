/**
 * Lightweight entity relationship graph for the Oracle memory system.
 *
 * Simplified standalone version of oracle-memory's EntityGraph.
 * Extracts entities from memory content (capitalized words, tech keywords),
 * builds directed, typed, weighted edges between entities, and stores
 * as JSON under `.oracle-memory/graph/` — compatible with the oracle-memory
 * package on disk.
 *
 * No LLM dependency: purely heuristic extraction.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export type EntityType = "person" | "technology" | "project" | "concept" | "tool";

export interface Entity {
  name: string;
  type: EntityType;
  firstSeen: string;
  lastSeen: string;
  memoryIds: string[];
  aliases: string[];
}

export interface Edge {
  from: string;
  to: string;
  relation: string;
  memoryIds: string[];
}

export interface PathHop {
  from: string;
  relation: string;
  to: string;
}

/** A node as rendered by the graph view. */
export interface GraphViewNode {
  id: string;
  label: string;
  type: EntityType;
  memoryCount: number;
  degree: number;
  lastSeen: string;
}

/** An edge as rendered by the graph view. */
export interface GraphViewEdge {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

/**
 * A renderable projection of the graph. `stats.truncated` is reported rather
 * than left implicit so a partial view never reads as the whole graph.
 */
export interface GraphView {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  stats: {
    totalEntities: number;
    totalEdges: number;
    renderedEntities: number;
    truncated: boolean;
  };
}

export interface EntityRelation {
  relation: string;
  other: string;
  direction: "in" | "out";
  weight: number;
}

export interface EntityDetail extends Entity {
  relations: EntityRelation[];
}

interface GraphData {
  entities: Record<string, Entity>;
  edges: Edge[];
}

// ── Helpers (ported from oracle-memory/src/graphExtract.ts) ───────────────

const TECH_KEYWORDS = new Set([
  "typescript", "javascript", "python", "rust", "go", "java", "c++", "c#",
  "react", "vue", "angular", "svelte", "node", "deno", "bun",
  "express", "next", "nuxt", "nest", "fastify", "hono",
  "postgres", "mysql", "sqlite", "mongodb", "redis", "elasticsearch",
  "docker", "kubernetes", "aws", "gcp", "azure", "terraform",
  "graphql", "rest", "grpc", "websocket", "mcp", "json-rpc",
  "git", "github", "ci/cd", "eslint", "prettier", "biome", "vitest",
  "jwt", "oauth", "openai", "anthropic", "transformers", "vectra",
  "linux", "windows", "macos", "bash", "zsh", "powershell",
]);

const CANONICAL: Record<string, string> = {
  typescript: "TypeScript", javascript: "JavaScript", nodejs: "Node", node: "Node",
  postgres: "PostgreSQL", postgresql: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite",
  mongodb: "MongoDB", redis: "Redis", graphql: "GraphQL", rest: "REST", grpc: "gRPC",
  jwt: "JWT", oauth: "OAuth", docker: "Docker", kubernetes: "Kubernetes",
  eslint: "ESLint", github: "GitHub", openai: "OpenAI", anthropic: "Anthropic",
  express: "Express", mcp: "MCP",
};

const RELATION_CONNECTIVES: { match: RegExp; relation: string }[] = [
  { match: /\bmigrat|\bupgrad|\bport(?:ed|ing)?\b|\bmov(?:ed|ing)\s+(?:from|to)\b/i, relation: "migrates" },
  { match: /\bdepends?\s+on\b|\brequires?\b|\bneeds?\b/i, relation: "depends_on" },
  { match: /\bimplement|\bbuilt\s+(?:with|on|using)\b|\bwritten\s+in\b|\bpowered\s+by\b/i, relation: "implements" },
  { match: /\buses?\b|\busing\b|\bwith\b|\bvia\b|\bcalls?\b/i, relation: "uses" },
  { match: /\bfor\b|\bin\b|\bon\b|\band\b/i, relation: "related_to" },
];

const STOP_WORDS = new Set([
  "the", "this", "that", "these", "those", "what", "which", "who", "whom",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "because", "but",
  "and", "or", "if", "while", "although", "about", "into", "through",
  "during", "before", "after", "above", "below", "between", "out",
  "off", "over", "under", "again", "further", "then", "once", "here",
  "there", "errors", "error", "issue", "issues", "fix", "fixed",
  "using", "used", "use", "also", "can", "will", "may", "would",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonical(name: string): string {
  const norm = name.trim().toLowerCase();
  return CANONICAL[norm] ?? name.trim();
}

function guessType(name: string): EntityType {
  const lower = name.toLowerCase();
  if (TECH_KEYWORDS.has(lower) || CANONICAL[lower]) return "technology";
  if (lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".py")) return "technology";
  if (/^[A-Z][a-z]+[A-Z]/.test(name)) return "technology";
  if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(name)) return "project";
  return "concept";
}

function extractEntities(content: string, tags: string[]): [string, EntityType][] {
  const entities: Map<string, EntityType> = new Map();
  const add = (raw: string, type: EntityType) => {
    const name = canonical(raw);
    if (!entities.has(name)) entities.set(name, type);
  };

  for (const tag of tags) add(tag, guessType(tag));

  // Multi-word capitalized phrases
  const capitalPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = capitalPattern.exec(content)) !== null) {
    const name = match[1];
    if (name.length > 2 && !STOP_WORDS.has(name.toLowerCase())) add(name, guessType(name));
  }

  // Single capitalized words (3+ chars)
  const singlePattern = /\b([A-Z][a-z]{2,})\b/g;
  while ((match = singlePattern.exec(content)) !== null) {
    const name = match[1];
    if (!STOP_WORDS.has(name.toLowerCase())) add(name, guessType(name));
  }

  // Acronyms
  const acronymPattern = /\b([A-Z]{2,6})\b/g;
  while ((match = acronymPattern.exec(content)) !== null) {
    const name = match[1];
    if (!STOP_WORDS.has(name.toLowerCase())) add(name, guessType(name));
  }

  // Tech keywords (case-insensitive)
  for (const keyword of [...TECH_KEYWORDS, ...Object.keys(CANONICAL)]) {
    const origMatch = new RegExp(`\\b${escapeRe(keyword)}\\b`, "i").exec(content);
    if (origMatch) add(origMatch[0], "technology");
  }

  return Array.from(entities.entries());
}

function firstIndexOf(content: string, name: string): number {
  const m = new RegExp(`\\b${escapeRe(name)}\\b`, "i").exec(content);
  return m ? m.index : -1;
}

function inferRelation(
  content: string,
  aRaw: string,
  bRaw: string,
): { from: string; to: string; relation: string } {
  const a = canonical(aRaw);
  const b = canonical(bRaw);
  const ia = firstIndexOf(content, a);
  const ib = firstIndexOf(content, b);

  let from = a, to = b, lo = ia, hi = ib;
  if (ia >= 0 && ib >= 0 && ib < ia) { from = b; to = a; lo = ib; hi = ia; }

  let relation = "related_to";
  if (lo >= 0 && hi >= 0 && hi > lo) {
    const gap = content.slice(lo, hi);
    for (const conn of RELATION_CONNECTIVES) {
      if (conn.match.test(gap)) { relation = conn.relation; break; }
    }
  }
  return { from, to, relation };
}

// ── Constants ─────────────────────────────────────────────────────────────

const HOP_DECAY = [1, 0.5, 0.25];
const MAX_HOPS = 2;

// ── KeyedMutex (single-process concurrency) ───────────────────────────────

class KeyedMutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const prev = this.queue;
    this.queue = this.queue.then(() => wait);
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

// ── EntityGraph ───────────────────────────────────────────────────────────

export class EntityGraph {
  private rootDir: string;
  private ready: Promise<void>;
  private cache: GraphData | null = null;
  private mutex = new KeyedMutex();

  constructor(rootDir: string, private readonly dataDirectory = ".oracle-memory") {
    this.rootDir = rootDir;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await fs.mkdir(path.join(this.rootDir, this.dataDirectory, "graph"), { recursive: true });
  }

  private graphPath(): string {
    return path.join(this.rootDir, this.dataDirectory, "graph", "graph.json");
  }

  private async load(): Promise<GraphData> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.graphPath(), "utf-8");
      this.cache = JSON.parse(raw) as GraphData;
    } catch {
      this.cache = { entities: {}, edges: [] };
    }
    return this.cache;
  }

  private async save(data: GraphData): Promise<void> {
    this.cache = data;
    const tmp = this.graphPath() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
    await fs.rename(tmp, this.graphPath());
  }

  private findEdge(edges: Edge[], from: string, to: string, relation: string): Edge | undefined {
    return edges.find((e) => e.from === from && e.to === to && e.relation === relation);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Extract entities/relations from memory content and index them in the graph.
   * Idempotent per memoryId: re-indexing strips the memory's prior contribution
   * so edge weights never double-count.
   */
  async indexMemory(memoryId: string, content: string, tags: string[]): Promise<void> {
    await this.ready;
    await this.mutex.acquire(async () => {
      const data = await this.load();
      const ts = new Date().toISOString();

      // Strip any prior contribution from this memoryId (idempotent re-index)
      this.detachMemory(data, memoryId);

      // ── Heuristic entities + weighted co-occurrence edges ──
      const entities = extractEntities(content, tags);
      for (const [name, type] of entities) {
        this.upsertEntity(data, name, type, memoryId, ts);
      }

      const names = entities.map(([name]) => name);
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const { from, to, relation } = inferRelation(content, names[i], names[j]);
          this.upsertEdge(data, from, to, relation, memoryId);
        }
      }

      await this.save(data);
    });
  }

  /**
   * Find entities matching the query, then do weighted multi-hop traversal to
   * surface related entities. Returns:
   * - `entities`: entity names that directly match the query text
   * - `related`: related entity names ranked by traversal score
   *   (edge weight × hop decay), strongest first.
   */
  async expandQuery(
    query: string,
  ): Promise<{ entities: string[]; related: { name: string; score: number }[] }> {
    await this.ready;
    const data = await this.load();

    // Find entities whose name matches the query text
    const directEntities = Object.keys(data.entities).filter((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(query);
    });

    // Weighted multi-hop traversal
    const scores = new Map<string, number>();
    let frontier = new Set(directEntities);
    const visited = new Set(directEntities);

    for (let hop = 1; hop <= MAX_HOPS && frontier.size > 0; hop++) {
      const next = new Set<string>();
      const decay = HOP_DECAY[hop - 1] ?? 0;
      for (const node of frontier) {
        for (const edge of data.edges) {
          const neighbor =
            edge.from === node ? edge.to :
            edge.to === node ? edge.from :
            null;
          if (!neighbor) continue;
          const gain = edge.memoryIds.length * decay;
          scores.set(neighbor, (scores.get(neighbor) ?? 0) + gain);
          if (!visited.has(neighbor)) {
            next.add(neighbor);
            visited.add(neighbor);
          }
        }
      }
      frontier = next;
    }

    const related = Array.from(scores.entries())
      .filter(([name]) => !directEntities.includes(name))
      .sort((a, b) => b[1] - a[1])
      .map(([name, score]) => ({ name, score }));

    return { entities: directEntities, related };
  }

  /**
   * Shortest relation path between two entities (BFS over undirected edges).
   * Returns an array of hops describing how `from` connects to `to`.
   * Returns `[]` if no path exists within `maxDepth`.
   */
  async findPath(fromRaw: string, toRaw: string, maxDepth = 4): Promise<PathHop[]> {
    await this.ready;
    const data = await this.load();
    const from = canonical(fromRaw);
    const to = canonical(toRaw);
    if (from === to || !data.entities[from] || !data.entities[to]) return [];

    const prev = new Map<string, PathHop>();
    const visited = new Set<string>([from]);
    let frontier = [from];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const edge of data.edges) {
          let neighbor: string | null = null;
          let hop: PathHop | null = null;

          if (edge.from === node) {
            neighbor = edge.to;
            hop = { from: edge.from, relation: edge.relation, to: edge.to };
          } else if (edge.to === node) {
            neighbor = edge.from;
            hop = { from: edge.to, relation: edge.relation, to: edge.from };
          }

          if (!neighbor || visited.has(neighbor)) continue;
          visited.add(neighbor);
          prev.set(neighbor, hop!);
          if (neighbor === to) return this.reconstructPath(prev, to);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    return [];
  }

  /**
   * Remove a memory's entities and edges from the graph.
   * Orphaned entities (with no remaining memoryIds) are cleaned up.
   */
  async removeMemory(memoryId: string): Promise<void> {
    await this.ready;
    await this.mutex.acquire(async () => {
      const data = await this.load();
      this.detachMemory(data, memoryId);
      // Drop now-orphaned entities
      for (const [name, entity] of Object.entries(data.entities)) {
        if (entity.memoryIds.length === 0) delete data.entities[name];
      }
      await this.save(data);
    });
  }

  /**
   * Prune stale entities from the graph:
   * - Entities with empty `memoryIds` (orphaned after memory removal/re-index).
   * - Entities whose `lastSeen` is older than `maxAgeDays` and have zero edges
   *   (isolated stale nodes, likely from long-deleted memories).
   *
   * Entities with remaining edges are kept even if old, because they may still
   * be reachable through active paths.
   *
   * @returns The number of entities and edges removed.
   */
  async pruneGraph(maxAgeDays = 90): Promise<{ removedEntities: number; removedEdges: number }> {
    await this.ready;
    return this.mutex.acquire(async () => {
      const data = await this.load();
      const cutoff = Date.now() - maxAgeDays * 86_400_000;
      const removedEntities: string[] = [];

      // Phase 1: identify removable entities
      for (const [name, entity] of Object.entries(data.entities)) {
        // Orphaned — no memories reference it anymore
        if (entity.memoryIds.length === 0) {
          removedEntities.push(name);
          continue;
        }
        // Isolated stale node: lastSeen too old AND no edges
        if (new Date(entity.lastSeen).getTime() < cutoff) {
          const hasEdges = data.edges.some((e) => e.from === name || e.to === name);
          if (!hasEdges) {
            removedEntities.push(name);
          }
        }
      }

      // Phase 2: remove entities and their edges
      for (const name of removedEntities) {
        delete data.entities[name];
      }
      const beforeEdges = data.edges.length;
      data.edges = data.edges.filter(
        (e) => data.entities[e.from] && data.entities[e.to],
      );

      if (removedEntities.length > 0 || data.edges.length !== beforeEdges) {
        await this.save(data);
      }

      return {
        removedEntities: removedEntities.length,
        removedEdges: beforeEdges - data.edges.length,
      };
    });
  }

  /** Graph statistics: entity count and edge count. */
  async getStats(): Promise<{ entityCount: number; edgeCount: number }> {
    await this.ready;
    const data = await this.load();
    return { entityCount: Object.keys(data.entities).length, edgeCount: data.edges.length };
  }

  /**
   * Serialize the graph for rendering.
   *
   * `limit` keeps the most-connected entities, since a force-directed layout
   * degrades well before the graph does. Edges are filtered to those whose
   * endpoints both survive, so the result never references a dropped node.
   */
  async toGraphView(opts?: { limit?: number; includeIsolated?: boolean }): Promise<GraphView> {
    await this.ready;
    const data = await this.load();
    const limit = opts?.limit ?? 200;
    const includeIsolated = opts?.includeIsolated ?? true;

    const degree = new Map<string, number>();
    for (const edge of data.edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }

    const allEntities = Object.values(data.entities);
    const totalEntities = allEntities.length;

    const ranked = allEntities
      .filter((e) => includeIsolated || (degree.get(e.name) ?? 0) > 0)
      .sort((a, b) => {
        const byDegree = (degree.get(b.name) ?? 0) - (degree.get(a.name) ?? 0);
        if (byDegree !== 0) return byDegree;
        return b.memoryIds.length - a.memoryIds.length;
      })
      .slice(0, limit);

    const kept = new Set(ranked.map((e) => e.name));

    return {
      nodes: ranked.map((e) => ({
        id: e.name,
        label: e.aliases[0] ?? e.name,
        type: e.type,
        memoryCount: e.memoryIds.length,
        degree: degree.get(e.name) ?? 0,
        lastSeen: e.lastSeen,
      })),
      edges: data.edges
        .filter((edge) => kept.has(edge.from) && kept.has(edge.to))
        .map((edge) => ({
          source: edge.from,
          target: edge.to,
          relation: edge.relation,
          weight: edge.memoryIds.length,
        })),
      stats: {
        totalEntities,
        totalEdges: data.edges.length,
        renderedEntities: ranked.length,
        truncated: ranked.length < totalEntities,
      },
    };
  }

  /**
   * One entity with its edges and the memory ids that mention it.
   *
   * Canonical names keep their original casing, so an exact hit is tried first
   * and a case-insensitive scan second — otherwise `entity redis` would miss a
   * node stored as `Redis`, which is how a human would type it.
   */
  async getEntity(rawName: string): Promise<EntityDetail | null> {
    await this.ready;
    const data = await this.load();
    const canonicalName = canonical(rawName);
    let name = canonicalName;
    let entity = data.entities[name];

    if (!entity) {
      const wanted = canonicalName.toLowerCase();
      const match = Object.keys(data.entities).find((key) => key.toLowerCase() === wanted);
      if (match) {
        name = match;
        entity = data.entities[match];
      }
    }

    if (!entity) return null;

    return {
      ...entity,
      relations: data.edges
        .filter((e) => e.from === name || e.to === name)
        .map((e) => ({
          relation: e.relation,
          other: e.from === name ? e.to : e.from,
          direction: e.from === name ? ("out" as const) : ("in" as const),
          weight: e.memoryIds.length,
        })),
    };
  }

  /** Entities ordered by connectedness, for a CLI overview. */
  async listEntities(limit = 50): Promise<Array<Entity & { degree: number }>> {
    const view = await this.toGraphView({ limit });
    const data = await this.load();
    return view.nodes
      .map((n) => {
        const entity = data.entities[n.id];
        return entity ? { ...entity, degree: n.degree } : null;
      })
      .filter((e): e is Entity & { degree: number } => e !== null);
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /** Upsert an entity node, merging by canonical name. */
  private upsertEntity(
    data: GraphData,
    rawName: string,
    type: EntityType,
    memoryId: string,
    ts: string,
  ): void {
    const name = canonical(rawName);
    const existing = data.entities[name];
    if (existing) {
      existing.lastSeen = ts;
      if (!existing.memoryIds.includes(memoryId)) existing.memoryIds.push(memoryId);
      if (type) existing.type = type;
      if (rawName !== name && !existing.aliases.includes(rawName)) existing.aliases.push(rawName);
    } else {
      data.entities[name] = {
        name,
        type,
        firstSeen: ts,
        lastSeen: ts,
        memoryIds: [memoryId],
        aliases: rawName !== name ? [rawName] : [],
      };
    }
  }

  /** Upsert a directional weighted edge (weight = #witnessing memories). */
  private upsertEdge(
    data: GraphData,
    rawFrom: string,
    rawTo: string,
    relation: string,
    memoryId: string,
  ): void {
    const from = canonical(rawFrom);
    const to = canonical(rawTo);
    if (from === to) return;
    const edge = this.findEdge(data.edges, from, to, relation);
    if (edge) {
      if (!edge.memoryIds.includes(memoryId)) edge.memoryIds.push(memoryId);
    } else {
      data.edges.push({ from, to, relation, memoryIds: [memoryId] });
    }
  }

  /** Strip a memory's contribution to nodes and edges (for re-index / removal). */
  private detachMemory(data: GraphData, memoryId: string): void {
    for (const entity of Object.values(data.entities)) {
      entity.memoryIds = entity.memoryIds.filter((id) => id !== memoryId);
    }
    for (const edge of data.edges) {
      edge.memoryIds = edge.memoryIds.filter((id) => id !== memoryId);
    }
    data.edges = data.edges.filter((e) => e.memoryIds.length > 0);
  }

  /** Reconstruct the BFS path from the predecessor map. */
  private reconstructPath(prev: Map<string, PathHop>, target: string): PathHop[] {
    const path: PathHop[] = [];
    let cur = target;
    while (prev.has(cur)) {
      const hop = prev.get(cur)!;
      path.unshift(hop);
      cur = hop.from;
    }
    return path;
  }
}
