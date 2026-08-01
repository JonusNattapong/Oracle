import { MAX_ACCOUNT_MEMORY_CHARS } from "../backends/chatgpt-browser/accountMemory.js";
import type { ExecutionBackend } from "../backends/backend.js";
import type { MemoryMirrorConfig } from "../config/project.js";
import type { MemoryPort } from "../orchestrator/ports.js";
import type { MemoryStoreEntry, MemoryType } from "./adapter.js";

/** Cheapest possible follow-up turn after the backend performs the save. */
const MIRROR_ACK_PROMPT = "Reply with exactly: OK";

export interface MirrorOutcome {
  attempted: boolean;
  saved: boolean;
  reason?: string;
}

export interface HybridMemoryAdapterOptions {
  /** Canonical store. Every read and every write goes here first. */
  local: MemoryPort;
  /** Backend able to drive the signed-in ChatGPT session. */
  backend: ExecutionBackend;
  mirror: MemoryMirrorConfig;
  model?: string;
  cwd?: string;
  /** Receives every mirror attempt, successful or not. */
  onMirror?: (entry: MemoryStoreEntry, outcome: MirrorOutcome) => void;
}

/**
 * Decides whether an entry is worth putting on the account-wide, user-visible
 * Saved Memory surface. Working memory and oversized entries are never eligible.
 */
export function shouldMirror(
  policy: MemoryMirrorConfig,
  entry: { type: MemoryType; content: string; tags?: string[]; importance?: number }
): boolean {
  if (entry.type === "working") return false;
  if (!policy.types.includes(entry.type)) return false;
  if ((entry.importance ?? 0) < policy.minImportance) return false;
  if (entry.content.trim().length > MAX_ACCOUNT_MEMORY_CHARS) return false;
  if (policy.tags?.length) {
    const tags = entry.tags ?? [];
    if (!policy.tags.some((tag) => tags.includes(tag))) return false;
  }
  return true;
}

/**
 * HybridMemoryAdapter keeps the local store canonical — full ids, tags, search,
 * and graph — and additionally pushes entries that clear the mirror policy to
 * the signed-in ChatGPT account so web conversations share that context.
 *
 * A failed mirror never fails the write: the local entry is already durable. The
 * outcome is recorded on the entry (`meta.mirrored`) and reported through
 * `onMirror` so a silent divergence between the two stores is still visible.
 */
export class HybridMemoryAdapter implements MemoryPort {
  private readonly local: MemoryPort;
  private readonly backend: ExecutionBackend;
  private readonly policy: MemoryMirrorConfig;
  private readonly model: string;
  private readonly cwd: string;
  private readonly onMirror?: (entry: MemoryStoreEntry, outcome: MirrorOutcome) => void;

  constructor(options: HybridMemoryAdapterOptions) {
    this.local = options.local;
    this.backend = options.backend;
    this.policy = options.mirror;
    this.model = options.model ?? "";
    this.cwd = options.cwd ?? process.cwd();
    this.onMirror = options.onMirror;
  }

  /** True when the configured backend can actually reach Saved Memory. */
  get canMirror(): boolean {
    return Boolean(this.backend.capabilities.accountMemory);
  }

  private async mirrorEntry(entry: MemoryStoreEntry): Promise<MirrorOutcome> {
    if (!this.canMirror) {
      return {
        attempted: false,
        saved: false,
        reason: `backend "${this.backend.id}" cannot write account memory`
      };
    }
    try {
      // The backend owns the save: it builds its own memory prompt from
      // `accountMemory`, verifies the confirmation, and reports the outcome.
      // `userPrompt` is still sent as a normal turn, so it must be a cheap
      // no-op rather than a second copy of the memory request.
      const response = await this.backend.run({
        model: this.model,
        systemPrompt: "",
        userPrompt: MIRROR_ACK_PROMPT,
        cwd: this.cwd,
        accountMemory: entry.content
      });
      const saved = Boolean(response.accountMemorySaved);
      return {
        attempted: true,
        saved,
        reason: saved ? undefined : "ChatGPT did not confirm the save"
      };
    } catch (error) {
      return {
        attempted: true,
        saved: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number }
  ): Promise<MemoryStoreEntry> {
    const entry = await this.local.remember(agent, type, content, opts);
    if (!shouldMirror(this.policy, { type, content, tags: opts?.tags, importance: opts?.importance })) {
      return entry;
    }

    const outcome = await this.mirrorEntry(entry);
    this.onMirror?.(entry, outcome);
    if (!outcome.saved) {
      console.warn(
        `[memory] mirror to ChatGPT account failed for ${entry.id}: ${outcome.reason ?? "unknown reason"}`
      );
    }
    // The returned entry carries the outcome so callers can surface it; the
    // durable record is the local one, which is already written.
    return { ...entry, meta: { ...entry.meta, mirrored: outcome.saved } };
  }

  // ── Everything else is the local store verbatim ───────────────────

  recall(opts?: {
    type?: MemoryType;
    agent?: string;
    tags?: string[];
    limit?: number;
    includeArchived?: boolean;
  }) {
    return this.local.recall(opts);
  }

  searchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }) {
    return this.local.searchMemories(query, opts);
  }

  scoredSearchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }) {
    return this.local.scoredSearchMemories(query, opts);
  }

  updateMemory(
    id: string,
    type: MemoryType,
    updates: { content?: string; tags?: string[]; importance?: number }
  ) {
    return this.local.updateMemory(id, type, updates);
  }

  getStats() {
    return this.local.getStats();
  }

  /**
   * Removes the local copy only. A mirrored entry stays in ChatGPT Saved Memory
   * because Saved Memory is account-wide and user-owned; deleting it silently on
   * a project-scoped forget would remove context the user never asked to lose.
   */
  forget(id: string, type: MemoryType) {
    return this.local.forget(id, type);
  }

  clearWorking(agent?: string) {
    return this.local.clearWorking(agent);
  }

  graphQuery(query: string, opts?: { agent?: string; limit?: number }) {
    return this.local.graphQuery?.(query, opts) ?? Promise.resolve([]);
  }

  graphFindPath(from: string, to: string) {
    return this.local.graphFindPath?.(from, to) ?? Promise.resolve([]);
  }

  getGraphStats() {
    return this.local.getGraphStats?.() ?? Promise.resolve({ entityCount: 0, edgeCount: 0 });
  }

  consolidate() {
    return (
      this.local.consolidate?.()
      ?? Promise.resolve({ consolidated: 0, created: null, archived: [] })
    );
  }

  pruneStale(opts?: { minImportance?: number; minStaleDays?: number }) {
    return this.local.pruneStale?.(opts) ?? Promise.resolve([]);
  }

  promoteWorking(opts?: { minAccessCount?: number }) {
    return this.local.promoteWorking?.(opts) ?? Promise.resolve([]);
  }

  runMaintenance(opts?: {
    minImportance?: number;
    minStaleDays?: number;
    minAccessCount?: number;
  }) {
    return this.local.runMaintenance?.(opts) ?? Promise.resolve({ pruned: [], promoted: [] });
  }

  reflect(opts?: { agent?: string }) {
    return this.local.reflect?.(opts) ?? Promise.resolve([]);
  }
}
