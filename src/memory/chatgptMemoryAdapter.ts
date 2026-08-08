import { createHash } from "node:crypto";
import {
  buildAccountMemoryForgetPrompt,
  buildAccountMemoryRecallPrompt,
  isAccountMemoryForgetConfirmed,
  parseAccountMemoryRecall,
  MAX_ACCOUNT_MEMORY_CHARS
} from "../backends/chatgpt-browser/accountMemory.js";
import type { ExecutionBackend } from "../backends/backend.js";
import {
  snapshotContains,
  type AccountMemorySnapshot
} from "../backends/chatgpt-browser/accountMemoryApi.js";
import { OracleError } from "../errors.js";
import type { MemoryPort } from "../orchestrator/ports.js";
import type { MemoryStoreEntry, MemoryType, RememberOptions } from "./adapter.js";

/** Marks entries whose durable copy lives in the ChatGPT account, not on disk. */
export const CHATGPT_MEMORY_SOURCE = "chatgpt-account";

/** Optional backend capability: list Saved Memory from the account itself. */
export interface AccountMemoryReader {
  listAccountMemories(): Promise<AccountMemorySnapshot>;
}

function debugMemory(message: string): void {
  if (process.env.ORACLE_DEBUG) console.debug(message);
}

export interface ChatGptMemoryAdapterOptions {
  /** Backend able to drive the signed-in ChatGPT session. */
  backend: ExecutionBackend;
  /**
   * Local store used as a shadow index. ChatGPT Saved Memory exposes no ids,
   * tags, importance, or timestamps, so those live here and are joined to the
   * remote text on read.
   */
  shadow: MemoryPort;
  /** Reuse window for a remote read, in minutes. 0 disables caching. */
  cacheTtlMinutes?: number;
  model?: string;
  cwd?: string;
  /** Injected in tests to observe non-fatal remote failures. */
  onWarning?: (message: string) => void;
}

function contentKey(content: string): string {
  return createHash("sha1").update(content.trim()).digest("hex").slice(0, 16);
}

/**
 * ChatGptMemoryAdapter stores durable memory in the signed-in ChatGPT account's
 * Saved Memory instead of on this machine.
 *
 * The remote store is deliberately weaker than the local one and this class does
 * not pretend otherwise:
 * - Saved Memory entries have no ids, tags, importance, or timestamps. Those are
 *   held in a local shadow index and joined by content hash.
 * - Reads are a natural-language round-trip, so ordering and completeness are
 *   best-effort. A failed read surfaces as an error, never as "no memories".
 * - Deletion is by exact text and only reported as done when ChatGPT confirms.
 * - `working` memory is never sent remotely: it is short-lived scratch state and
 *   Saved Memory is a small, account-wide, user-visible surface.
 */
export class ChatGptMemoryAdapter implements MemoryPort {
  private readonly backend: ExecutionBackend;
  private readonly shadow: MemoryPort;
  private readonly cacheTtlMs: number;
  private readonly model: string;
  private readonly cwd: string;
  private readonly onWarning?: (message: string) => void;
  private cache: { at: number; entries: string[] } | null = null;

  constructor(options: ChatGptMemoryAdapterOptions) {
    if (!options.backend.capabilities.accountMemory) {
      throw new OracleError(
        "ORACLE_MEMORY_STORE_UNSUPPORTED",
        `Backend "${options.backend.id}" cannot write ChatGPT account memory.`,
        'Set memory.store to "local", or use backend "chatgpt-browser".'
      );
    }
    this.backend = options.backend;
    this.shadow = options.shadow;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMinutes ?? 10) * 60_000;
    this.model = options.model ?? "";
    this.cwd = options.cwd ?? process.cwd();
    this.onWarning = options.onWarning;
  }

  /**
   * The backend always sends `userPrompt` as a normal turn. When saving, the
   * save itself is driven by `accountMemory` — the backend builds its own memory
   * prompt, verifies the confirmation, and reports the outcome on the response —
   * so the prompt here must be a cheap no-op rather than a second copy of the
   * memory request, which would save the entry twice.
   */
  private static readonly ACK_PROMPT = "Reply with exactly: OK";

  private async ask(userPrompt: string, accountMemory?: string) {
    return this.backend.run({
      model: this.model,
      systemPrompt: "",
      userPrompt,
      cwd: this.cwd,
      accountMemory
    });
  }

  private async askText(userPrompt: string): Promise<string> {
    return (await this.ask(userPrompt)).text ?? "";
  }

  /** `working` memory stays local; everything else is account-visible. */
  private isRemoteType(type: MemoryType): boolean {
    return type !== "working";
  }

  async remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: RememberOptions
  ): Promise<MemoryStoreEntry> {
    if (!this.isRemoteType(type)) {
      return this.shadow.remember(agent, type, content, opts);
    }
    if (content.trim().length > MAX_ACCOUNT_MEMORY_CHARS) {
      throw new OracleError(
        "ORACLE_ACCOUNT_MEMORY_INVALID",
        `ChatGPT account memory is limited to ${MAX_ACCOUNT_MEMORY_CHARS} characters.`,
        'Shorten the entry, or set memory.store to "local"/"hybrid" for long-form memory.'
      );
    }

    const response = await this.ask(ChatGptMemoryAdapter.ACK_PROMPT, content);
    if (!response.accountMemorySaved) {
      throw new OracleError(
        "ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED",
        "ChatGPT did not confirm the memory was saved.",
        "Check that Saved Memory is enabled and not full for the signed-in account.",
        { reply: (response.text ?? "").slice(0, 200) }
      );
    }
    this.cache = null;

    // Shadow-index it so ids, tags, and importance survive locally.
    return this.shadow.remember(agent, type, content, {
      ...opts,
      meta: { ...opts?.meta, remote: CHATGPT_MEMORY_SOURCE, contentKey: contentKey(content) }
    });
  }

  /**
   * Reads Saved Memory, honouring the cache window.
   *
   * Prefers the account's own listing; asking ChatGPT to describe its memory is
   * only a fallback, because that route has been observed answering "no
   * memories" for an account holding four. Either way an unreadable account
   * throws — resolving to `[]` would let a refusal look exactly like an empty
   * account and quietly report that Oracle remembers nothing.
   */
  private async readRemote(query?: string): Promise<string[]> {
    if (!query && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.entries;
    }

    const reader = this.backend as Partial<AccountMemoryReader>;
    if (typeof reader.listAccountMemories === "function") {
      const snapshot = await reader.listAccountMemories();
      if (snapshot.known) {
        if (!query) this.cache = { at: Date.now(), entries: snapshot.entries };
        return snapshot.entries;
      }
      debugMemory(
        `[memory] account listing unavailable (${snapshot.reason}); asking ChatGPT instead`
      );
    }

    const reply = await this.askText(buildAccountMemoryRecallPrompt(query));
    const result = parseAccountMemoryRecall(reply);
    if (!result.readable) {
      throw new OracleError(
        "ORACLE_ACCOUNT_MEMORY_UNREADABLE",
        `Could not read ChatGPT Saved Memory: ${result.reason}.`,
        'Retry, or set memory.store to "local"/"hybrid" so reads do not depend on the account.',
        { reply: reply.slice(0, 200) }
      );
    }
    if (!query) this.cache = { at: Date.now(), entries: result.entries };
    return result.entries;
  }

  /**
   * Joins remote texts with the local shadow index. Remote-only texts (saved
   * from the ChatGPT web UI directly) are surfaced with a synthetic id so they
   * are visible even though Oracle never wrote them.
   */
  private async merge(
    remote: string[],
    local: MemoryStoreEntry[]
  ): Promise<MemoryStoreEntry[]> {
    const byKey = new Map(local.map((entry) => [contentKey(entry.content), entry]));
    const merged: MemoryStoreEntry[] = [];
    for (const text of remote) {
      const key = contentKey(text);
      const known = byKey.get(key);
      if (known) {
        merged.push(known);
        byKey.delete(key);
        continue;
      }
      merged.push({
        id: `chatgpt:${key}`,
        ts: new Date(0).toISOString(),
        agent: "chatgpt",
        type: "fact",
        content: text,
        tags: [],
        meta: { remote: CHATGPT_MEMORY_SOURCE, shadowed: false },
        source: CHATGPT_MEMORY_SOURCE,
        accessCount: 0,
        lastAccessed: new Date(0).toISOString(),
        decayRate: 0
      });
    }
    // Local-only entries are working memory or entries ChatGPT has since dropped;
    // keep the working ones, drop stale remote-backed shadows.
    for (const entry of byKey.values()) {
      if (entry.type === "working") merged.push(entry);
    }
    return merged;
  }

  async recall(opts?: {
    type?: MemoryType;
    agent?: string;
    tags?: string[];
    limit?: number;
    includeArchived?: boolean;
    includeStale?: boolean;
  }): Promise<MemoryStoreEntry[]> {
    const local = await this.shadow.recall({ ...opts, limit: opts?.limit ?? 200 });
    if (opts?.type === "working") return local;
    const remote = await this.readRemote();
    const merged = await this.merge(remote, local);
    const filtered = opts?.type ? merged.filter((e) => e.type === opts.type) : merged;
    return filtered.slice(0, opts?.limit ?? 20);
  }

  async searchMemories(
    query: string,
    opts?: { type?: MemoryType; agent?: string; limit?: number; includeStale?: boolean }
  ): Promise<MemoryStoreEntry[]> {
    const local = await this.shadow.searchMemories(query, { ...opts, limit: opts?.limit ?? 200 });
    if (opts?.type === "working") return local;
    const remote = await this.readRemote(query);
    const merged = await this.merge(remote, local);
    return merged.slice(0, opts?.limit ?? 50);
  }

  /** Saved Memory has no ranking signal, so scored search is plain search. */
  async scoredSearchMemories(
    query: string,
    opts?: { type?: MemoryType; agent?: string; limit?: number; includeStale?: boolean }
  ): Promise<MemoryStoreEntry[]> {
    return this.searchMemories(query, opts);
  }

  verifyAnchors(opts?: { includeArchived?: boolean; paths?: string[] }) {
    return this.shadow.verifyAnchors?.(opts) ?? Promise.resolve({ totalAnchored: 0, fresh: 0, drifted: 0, missing: 0, unavailable: 0, entries: [] });
  }

  reanchorMemory(id: string, type: MemoryType) {
    return this.shadow.reanchorMemory?.(id, type) ?? Promise.resolve(null);
  }

  /**
   * Saved Memory cannot be edited in place: an update is a delete followed by a
   * save, and the local shadow is only advanced once the remote save confirms.
   */
  async updateMemory(
    id: string,
    type: MemoryType,
    updates: { content?: string; tags?: string[]; importance?: number }
  ): Promise<MemoryStoreEntry | null> {
    const existing = (await this.shadow.recall({ type, limit: 1_000 }))
      .find((entry) => entry.id === id);
    if (!existing) return null;

    if (updates.content && updates.content !== existing.content && this.isRemoteType(type)) {
      await this.forgetRemote(existing.content);
      const response = await this.ask(ChatGptMemoryAdapter.ACK_PROMPT, updates.content);
      if (!response.accountMemorySaved) {
        throw new OracleError(
          "ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED",
          "ChatGPT did not confirm the updated memory was saved.",
          "The previous entry was removed; re-run the update once Saved Memory is available.",
          { reply: (response.text ?? "").slice(0, 200) }
        );
      }
      this.cache = null;
    }
    return this.shadow.updateMemory(id, type, updates);
  }

  /**
   * Asks the account to delete an entry, then checks whether it is really gone.
   *
   * ChatGPT's confirmation is its own claim, and on the write side that claim
   * was observed arriving for an entry the account never stored. The deletion
   * side has no reason to be more trustworthy, so the account is re-read rather
   * than taken at its word. `verified: false` means the account could not be
   * inspected — neither a success nor a failure.
   */
  private async forgetRemote(
    content: string
  ): Promise<{ removed: boolean; verified: boolean; reason?: string }> {
    const reply = await this.askText(buildAccountMemoryForgetPrompt(content));
    const claimed = isAccountMemoryForgetConfirmed(reply);
    this.cache = null;

    const reader = this.backend as Partial<AccountMemoryReader>;
    if (typeof reader.listAccountMemories !== "function") {
      return { removed: claimed, verified: false, reason: "backend cannot list account memory" };
    }
    const snapshot = await reader.listAccountMemories();
    if (!snapshot.known) {
      return { removed: claimed, verified: false, reason: snapshot.reason };
    }
    return { removed: !snapshotContains(snapshot, content), verified: true };
  }

  async forget(id: string, type: MemoryType): Promise<void> {
    const existing = (await this.shadow.recall({ type, limit: 1_000 }))
      .find((entry) => entry.id === id);
    if (existing && this.isRemoteType(type)) {
      const outcome = await this.forgetRemote(existing.content);
      if (!outcome.removed) {
        throw new OracleError(
          "ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED",
          outcome.verified
            ? "The memory is still present in the ChatGPT account after the delete."
            : "ChatGPT did not confirm the memory was deleted.",
          "Delete it from ChatGPT settings → Personalization → Manage memory, then retry."
        );
      }
      if (!outcome.verified) {
        // The local copy still goes, but say plainly that the account copy is
        // unaccounted for rather than reporting a clean delete.
        console.warn(
          `[memory] ChatGPT reported the delete, but the account could not be checked (${outcome.reason ?? "unknown reason"}). The account copy is unverified.`
        );
      }
    }
    await this.shadow.forget(id, type);
  }

  /** Working memory is local by definition, so this never touches the account. */
  async clearWorking(agent?: string): Promise<number> {
    return this.shadow.clearWorking(agent);
  }

  async getStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    byAgent: Record<string, number>;
  }> {
    const entries = await this.recall({ limit: 10_000 });
    const byType: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const entry of entries) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      byAgent[entry.agent] = (byAgent[entry.agent] ?? 0) + 1;
    }
    return { total: entries.length, byType, byAgent };
  }

  // ── Advanced features are local-only: Saved Memory has no graph, no decay,
  // and no consolidation surface. They operate on the shadow index. ──────────

  graphQuery(query: string, opts?: { agent?: string; limit?: number; includeStale?: boolean }) {
    return this.shadow.graphQuery?.(query, opts) ?? Promise.resolve([]);
  }

  graphWhy(memoryId: string, question: string) {
    return this.shadow.graphWhy?.(memoryId, question) ?? Promise.resolve({ reachable: false, paths: [], entities: [] });
  }

  getGraphStats() {
    return this.shadow.getGraphStats?.() ?? Promise.resolve({ entityCount: 0, edgeCount: 0 });
  }

  reflect(opts?: { agent?: string }) {
    return this.shadow.reflect?.(opts) ?? Promise.resolve([]);
  }
}
