/**
 * maintenance.ts — Background memory maintenance for Oracle.
 *
 * Two operations:
 *   1. pruneStaleMemories  – soft-delete durable memories that are old + low-value
 *   2. promoteWorkingMemories – graduate high-access working memories into insight
 *
 * Designed as pure utility functions that take MemoryStoreEntry[] + optional
 * persistence callbacks so they work with any backend (adapter, MCP, etc.).
 */

import type { MemoryStoreEntry } from "./adapter.js";

// ── Options / Result types ────────────────────────────────────────────────

export interface MaintenanceOptions {
  /** Minimum importance score (0-1) to retain a memory. Default: 0.2. */
  minImportance?: number;
  /** Days since last access before a memory is considered stale. Default: 30. */
  minStaleDays?: number;
  /** Minimum access count to promote a working memory. Default: 3. */
  minAccessCount?: number;
}

export interface MaintenanceResult {
  /** IDs of memories that were pruned. */
  pruned: string[];
  /** IDs of working memories that were promoted. */
  promoted: string[];
}

// ── pruneStaleMemories ────────────────────────────────────────────────────

/**
 * Soft-delete durable memories (fact / insight) that haven't been accessed in
 * `minStaleDays` and whose importance has decayed below `minImportance`.
 *
 * Pruned entries are marked with `pruned: true` and persisted via `saveFn`.
 * They are **not** deleted from disk — only flagged — so they remain
 * auditable and recoverable.
 *
 * @param entries – All loaded memory entries (caller is responsible for scope).
 * @param opts    – Override defaults for staleness / importance thresholds.
 * @param saveFn  – Async callback to persist an updated entry. If omitted the
 *                  in-memory entry is still mutated but never written.
 * @returns       The IDs of entries that were pruned.
 */
export async function pruneStaleMemories(
  entries: MemoryStoreEntry[],
  opts?: MaintenanceOptions,
  saveFn?: (entry: MemoryStoreEntry) => Promise<void>,
): Promise<string[]> {
  const minImportance = opts?.minImportance ?? 0.2;
  const minStaleDays = opts?.minStaleDays ?? 30;
  const now = Date.now();
  const pruned: string[] = [];

  for (const entry of entries) {
    // Only durable long-term types are eligible for pruning.
    if (entry.type !== "fact" && entry.type !== "insight") continue;

    // Skip entries already archived, consolidated, or previously pruned.
    if (entry.archived) continue;
    if (entry.consolidatedBy) continue;
    if (entry.pruned) continue;

    // ── Staleness check ──────────────────────────────────────────────
    const lastAccess = new Date(entry.lastAccessed ?? entry.ts).getTime();
    const daysSinceAccess = (now - lastAccess) / 86_400_000;
    if (daysSinceAccess < minStaleDays) continue;

    // ── Importance check ─────────────────────────────────────────────
    const importance = entry.importance ?? 0.5;
    if (importance >= minImportance) continue;

    // ── Prune ────────────────────────────────────────────────────────
    entry.pruned = true;
    if (saveFn) {
      await saveFn(entry);
    }
    pruned.push(entry.id);
  }

  return pruned;
}

// ── promoteWorkingMemories ────────────────────────────────────────────────

/**
 * Promote working memories that have been accessed `minAccessCount` or more
 * times into durable `insight` memories for long-term retention.
 *
 * The promotion can be performed in one of three ways:
 *   1. **moveFn** – An atomic move operation (create under the new type +
 *                   delete the old file in one logical step). Preferred when
 *                   the backend supports it (e.g. `MemoryAdapter.moveMemory`).
 *   2. **saveFn + deleteFn** – Save a copy with `type: "insight"` under the
 *                              new type directory, then delete the original.
 *   3. **Neither** – Entries are still identified but not persisted (dry-run).
 *
 * Promoted entries have their `accessCount` reset to 0 and `lastAccessed` set
 * to the promotion timestamp. A `promotedFrom` record is stored in `meta` so
 * the provenance trail is preserved.
 *
 * @param entries  – All loaded memory entries (caller is responsible for scope).
 * @param opts     – Override the minimum access count.
 * @param saveFn   – Callback to persist a newly promoted entry. Required when
 *                   `moveFn` is not provided (used together with `deleteFn`).
 * @param deleteFn – Callback to remove the original working entry after
 *                   promoting. Required when `moveFn` is not provided.
 * @param moveFn   – Atomic move callback that re-types an entry in one
 *                   operation. When given, `saveFn` and `deleteFn` are unused.
 * @returns        The IDs of working entries that were promoted.
 */
export async function promoteWorkingMemories(
  entries: MemoryStoreEntry[],
  opts?: MaintenanceOptions,
  saveFn?: (entry: MemoryStoreEntry) => Promise<void>,
  deleteFn?: (id: string, type: string) => Promise<void>,
  moveFn?: (entry: MemoryStoreEntry, targetType: string) => Promise<MemoryStoreEntry>,
): Promise<string[]> {
  const minAccessCount = opts?.minAccessCount ?? 3;
  const promoted: string[] = [];

  for (const entry of entries) {
    // Only working memories are eligible for promotion.
    if (entry.type !== "working") continue;
    if (entry.archived) continue;

    // Must have been retrieved enough times to be worth promoting.
    if ((entry.accessCount ?? 0) < minAccessCount) continue;

    // ── Promote ──────────────────────────────────────────────────────
    if (moveFn) {
      // Atomic move — backend handles both creation and deletion.
      const moved = await moveFn(entry, "insight");
      if (moved) {
        promoted.push(entry.id);
      }
    } else if (saveFn && deleteFn) {
      // Two-step promotion: save a copy under the new type, then delete the old.
      const promotedEntry: MemoryStoreEntry = {
        ...entry,
        type: "insight",
        accessCount: 0,
        lastAccessed: new Date().toISOString(),
        meta: {
          ...entry.meta,
          promotedFrom: { id: entry.id, type: entry.type },
        },
      };
      await saveFn(promotedEntry);
      await deleteFn(entry.id, entry.type);
      promoted.push(entry.id);
    }
    // If neither moveFn nor (saveFn + deleteFn) is provided, we still
    // identify candidates but cannot persist — caller gets a dry-run list.
  }

  return promoted;
}

// ── runMaintenance (convenience) ──────────────────────────────────────────

/**
 * Run both maintenance operations in sequence and return a combined result.
 *
 * This is a convenience wrapper; callers may also invoke the individual
 * functions directly for finer control (e.g. different entry scopes).
 *
 * @param entries – All loaded memory entries.
 * @param opts    – Shared maintenance options for both operations.
 * @param saveFn  – Persist callback used by both pruning (update in-place)
 *                  and promotion (create new entry).
 * @param deleteFn – Delete callback used by promotion (remove old working).
 * @param moveFn   – Atomic move callback (alternative to saveFn+deleteFn
 *                   for promotion).
 */
export async function runMaintenance(
  entries: MemoryStoreEntry[],
  opts?: MaintenanceOptions,
  saveFn?: (entry: MemoryStoreEntry) => Promise<void>,
  deleteFn?: (id: string, type: string) => Promise<void>,
  moveFn?: (entry: MemoryStoreEntry, targetType: string) => Promise<MemoryStoreEntry>,
): Promise<MaintenanceResult> {
  const [pruned, promoted] = await Promise.all([
    pruneStaleMemories(entries, opts, saveFn),
    promoteWorkingMemories(entries, opts, saveFn, deleteFn, moveFn),
  ]);
  return { pruned, promoted };
}
