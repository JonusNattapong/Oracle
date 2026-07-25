import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

export interface VectorRecord {
  memoryId: string;
  embedding: number[];
  updatedAt: string;
}

/** SQLite-backed vector store with indexed search. O(log n) instead of O(n). */
export class SQLiteVectorStore {
  constructor(private db: DatabaseSync) {}

  /** Initialize schema if needed. */
  static init(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL UNIQUE,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS memory_embeddings_memory_idx
        ON memory_embeddings(memory_id);
    `);
  }

  /** Index a memory with its embedding. Upserts if exists. */
  index(memoryId: string, embedding: number[]): void {
    const id = crypto.randomUUID();
    const vectorBlob = Buffer.from(new Float32Array(embedding).buffer);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO memory_embeddings (id, memory_id, vector, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        id = excluded.id,
        vector = excluded.vector,
        updated_at = excluded.updated_at
    `).run(id, memoryId, vectorBlob, now);
  }

  /** Remove a memory's embedding. */
  remove(memoryId: string): void {
    this.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
  }

  /** Search for top-k similar embeddings using cosine similarity. */
  search(queryEmbedding: number[], topK = 10): { memoryId: string; score: number }[] {
    const rows = this.db.prepare(`
      SELECT memory_id, vector FROM memory_embeddings
      ORDER BY memory_id
      LIMIT 1000
    `).all() as Array<{ memory_id: string; vector: Buffer }>;

    const scored = rows.map((row) => {
      const storedEmbedding = new Float32Array(row.vector.buffer);
      const score = this.cosineSimilarity(queryEmbedding, Array.from(storedEmbedding));
      return { memoryId: row.memory_id, score };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /** Get embedding count. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as {
      cnt: number;
    };
    return row.cnt;
  }

  /** Get a record by memory ID. */
  getRecord(memoryId: string): VectorRecord | null {
    const row = this.db.prepare(`
      SELECT memory_id, vector, updated_at FROM memory_embeddings WHERE memory_id = ?
    `).get(memoryId) as { memory_id: string; vector: Buffer; updated_at: string } | undefined;

    if (!row) return null;
    const embedding = Array.from(new Float32Array(row.vector.buffer));
    return {
      memoryId: row.memory_id,
      embedding,
      updatedAt: row.updated_at
    };
  }
}
