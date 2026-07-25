import type { BM25Result } from "./bm25Store.js";
import type { SQLiteVectorStore } from "./sqliteVectorStore.js";
import type { BM25Store } from "./bm25Store.js";

export interface HybridResult {
  memoryId: string;
  vectorScore: number;
  bm25Score: number;
  rrfScore: number;
}

/**
 * Hybrid retrieval combining BM25 (lexical) and vector (semantic) ranking.
 * Uses Reciprocal Rank Fusion (RRF) to merge scores fairly.
 *
 * RRF formula: score = 1 / (k + rank) for each result, summed across rankers.
 * k = 60 is a common choice (prevents rank=0 from dominating).
 */
export class HybridRetrieval {
  constructor(
    private vectorStore: SQLiteVectorStore,
    private bm25Store: BM25Store,
    private k = 60
  ) {}

  /**
   * Hybrid search: run both vector and BM25, fuse results with RRF.
   * @param query User query string
   * @param queryEmbedding Query vector (from embedding provider)
   * @param topK Results to return
   * @returns Fused results sorted by RRF score
   */
  search(query: string, queryEmbedding: number[], topK = 10): HybridResult[] {
    // Run both searches independently
    const bm25Results = this.bm25Store.search(query, topK * 2);
    const vectorResults = this.vectorStore.search(queryEmbedding, topK * 2);

    // Build rank maps (lower rank = better)
    const vectorRanks = new Map(vectorResults.map((r, i) => [r.memoryId, i]));
    const bm25Ranks = new Map(bm25Results.map((r, i) => [r.memoryId, i]));

    // Collect all memory IDs
    const memoryIds = new Set([...vectorRanks.keys(), ...bm25Ranks.keys()]);

    // Calculate RRF score for each result
    const fused: HybridResult[] = [];
    for (const memoryId of memoryIds) {
      const vectorRank = vectorRanks.get(memoryId);
      const bm25Rank = bm25Ranks.get(memoryId);

      const vectorScore = vectorRank !== undefined ? 1 / (this.k + vectorRank) : 0;
      const bm25Score = bm25Rank !== undefined ? 1 / (this.k + bm25Rank) : 0;
      const rrfScore = vectorScore + bm25Score;

      fused.push({
        memoryId,
        vectorScore,
        bm25Score,
        rrfScore,
      });
    }

    // Sort by RRF score descending, return top-k
    return fused.sort((a, b) => b.rrfScore - a.rrfScore).slice(0, topK);
  }

  /**
   * Vector-only search (fallback when embedder is down).
   */
  vectorSearch(queryEmbedding: number[], topK = 10): HybridResult[] {
    const results = this.vectorStore.search(queryEmbedding, topK);
    return results.map((r) => ({
      memoryId: r.memoryId,
      vectorScore: r.score,
      bm25Score: 0,
      rrfScore: r.score,
    }));
  }

  /**
   * BM25-only search (fallback when embedder is down).
   */
  bm25Search(query: string, topK = 10): HybridResult[] {
    const results = this.bm25Store.search(query, topK);
    return results.map((r) => ({
      memoryId: r.memoryId,
      vectorScore: 0,
      bm25Score: r.score,
      rrfScore: r.score,
    }));
  }
}
