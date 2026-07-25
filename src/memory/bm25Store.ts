import { DatabaseSync } from "node:sqlite";

export interface BM25Result {
  memoryId: string;
  score: number;
}

/**
 * BM25 full-text search using SQLite FTS5.
 * Native SQLite FTS5 provides BM25 ranking out of the box.
 */
export class BM25Store {
  constructor(private db: DatabaseSync) {}

  /** Initialize FTS5 virtual table. */
  static init(db: DatabaseSync): void {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_content_search USING fts5(
        content,
        memory_id UNINDEXED
      );
    `);
  }

  /** Index memory content for BM25. */
  index(memoryId: string, content: string): void {
    // Remove old entry if exists
    this.db.prepare(
      "DELETE FROM memory_content_search WHERE memory_id = ?"
    ).run(memoryId);

    // Insert new entry
    this.db.prepare(`
      INSERT INTO memory_content_search (memory_id, content)
      VALUES (?, ?)
    `).run(memoryId, content);
  }

  /** Remove indexed content. */
  remove(memoryId: string): void {
    this.db.prepare("DELETE FROM memory_content_search WHERE memory_id = ?").run(memoryId);
  }

  /** Search using BM25 ranking. Returns scored results sorted by relevance. */
  search(query: string, topK = 10): BM25Result[] {
    const rows = this.db.prepare(`
      SELECT memory_id, rank FROM memory_content_search
      WHERE memory_content_search MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `).all(query, topK) as Array<{ memory_id: string; rank: number }>;

    // FTS5 returns negative rank (lower = better)
    return rows.map((row) => ({
      memoryId: row.memory_id,
      score: Math.exp(row.rank), // Convert negative rank to positive score
    }));
  }

  /** Search with phrase matching (strict). */
  phraseSearch(query: string, topK = 10): BM25Result[] {
    const quoted = `"${query.replace(/"/g, '""')}"`;
    return this.search(quoted, topK);
  }

  /** Get document count. */
  count(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM memory_content_search"
    ).get() as { cnt: number };
    return row.cnt;
  }

  /** Clear all indexed content (for migrations). */
  clear(): void {
    this.db.prepare("DELETE FROM memory_content_search").run();
  }
}
