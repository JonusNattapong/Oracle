import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { SQLiteVectorStore } from "./sqliteVectorStore.js";
import { BM25Store } from "./bm25Store.js";
import { HybridRetrieval } from "./hybridRetrieval.js";
import { globalRegistry, type EmbeddingProvider } from "./embeddingProviders.js";
import type { MemoryStoreEntry } from "./adapter.js";

/**
 * SQLite-backed memory search backend.
 * Replaces the JSON-based VectorStore with indexed retrieval.
 */
export class SQLiteMemoryBackend {
  private vectorStore: SQLiteVectorStore;
  private bm25Store: BM25Store;
  private hybrid: HybridRetrieval;
  private embeddingProvider: EmbeddingProvider | null = null;
  private migrationDone = false;

  constructor(private db: DatabaseSync, private vectorsJsonPath: string) {
    SQLiteVectorStore.init(db);
    BM25Store.init(db);
    this.vectorStore = new SQLiteVectorStore(db);
    this.bm25Store = new BM25Store(db);
    this.hybrid = new HybridRetrieval(this.vectorStore, this.bm25Store);
  }

  async initialize(): Promise<void> {
    // Detect available embedding provider
    this.embeddingProvider = await globalRegistry.detectAvailable();

    // Migrate vectors.json → SQLite if needed
    if (!this.migrationDone) {
      await this.migrateVectorsJson();
      this.migrationDone = true;
    }
  }

  /**
   * One-time migration: load vectors.json and backfill into SQLite.
   * Keep vectors.json as fallback.
   */
  private async migrateVectorsJson(): Promise<void> {
    try {
      const raw = await fs.readFile(this.vectorsJsonPath, "utf8");
      const records = JSON.parse(raw) as Array<{
        memoryId: string;
        embedding: number[];
        updatedAt: string;
      }>;

      for (const record of records) {
        try {
          this.vectorStore.index(record.memoryId, record.embedding);
        } catch {
          // Skip corrupt records
        }
      }
    } catch {
      // vectors.json doesn't exist yet (first run), that's fine
    }
  }

  /**
   * Index a memory with vector embedding (if provider available).
   */
  async indexMemory(memoryId: string, content: string): Promise<void> {
    if (!this.embeddingProvider) return;

    try {
      const embedding = await this.embeddingProvider.embed(content);
      this.vectorStore.index(memoryId, embedding);
    } catch {
      // Silently fail on embedding error; BM25 still works
    }
  }

  /**
   * Index memory content for BM25 search.
   */
  indexContent(memoryId: string, content: string): void {
    this.bm25Store.index(memoryId, content);
  }

  /**
   * Hybrid search: BM25 + vector (if embedder available) with RRF fusion.
   */
  async search(query: string, topK = 50): Promise<Array<{ memoryId: string; score: number }>> {
    // If embedder is down, use BM25 only
    if (!this.embeddingProvider) {
      return this.bm25Store.search(query, topK).map((r) => ({
        memoryId: r.memoryId,
        score: r.score,
      }));
    }

    try {
      const embedding = await this.embeddingProvider.embed(query);
      const results = this.hybrid.search(query, embedding, topK);
      return results.map((r) => ({
        memoryId: r.memoryId,
        score: r.rrfScore,
      }));
    } catch {
      // Fallback to BM25 if embedding fails
      return this.bm25Store.search(query, topK).map((r) => ({
        memoryId: r.memoryId,
        score: r.score,
      }));
    }
  }

  /**
   * Remove a memory from both vector and BM25 indices.
   */
  remove(memoryId: string): void {
    this.vectorStore.remove(memoryId);
    this.bm25Store.remove(memoryId);
  }

  /**
   * Get embedding provider status.
   */
  getProviderStatus(): {
    available: boolean;
    provider: string | null;
  } {
    return {
      available: this.embeddingProvider !== null,
      provider: this.embeddingProvider?.name ?? null,
    };
  }

  /**
   * Fallback to lexical-only search (for tests or debugging).
   */
  lexicalOnly(query: string, topK = 50): Array<{ memoryId: string; score: number }> {
    return this.bm25Store.search(query, topK).map((r) => ({
      memoryId: r.memoryId,
      score: r.score,
    }));
  }

  /**
   * Get retrieval stats.
   */
  getStats(): {
    vectorCount: number;
    contentCount: number;
  } {
    return {
      vectorCount: this.vectorStore.count(),
      contentCount: this.bm25Store.count(),
    };
  }
}
