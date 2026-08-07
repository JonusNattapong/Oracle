import fs from "node:fs/promises";

export interface EvalQuery {
  id: string;
  query: string;
  relevantIds: string[];
  category: string;
}

export interface EvalDataset {
  version: string;
  description: string;
  queries: EvalQuery[];
  metrics: {
    recall_targets: number[];
    mrr: boolean;
    description: string;
  };
}

export interface RecallMetrics {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  avgRecall: number;
}

/**
 * Evaluation harness for measuring memory retrieval quality.
 * Computes recall@k and MRR (Mean Reciprocal Rank).
 */
export class EvalHarness {
  private dataset: EvalDataset;

  private constructor(dataset: EvalDataset) {
    this.dataset = dataset;
  }

  static async loadAsync(datasetPath: string): Promise<EvalHarness> {
    const raw = await fs.readFile(datasetPath, "utf8");
    const dataset = JSON.parse(raw) as EvalDataset;
    return new EvalHarness(dataset);
  }

  /**
   * Evaluate a retrieval function.
   * @param retrievalFn Function that takes query string, returns ordered list of memory IDs.
   */
  async evaluate(
    retrievalFn: (query: string) => Promise<string[]>
  ): Promise<RecallMetrics> {
    const targets = [...new Set(this.dataset.metrics.recall_targets)].sort((a, b) => a - b);
    const recallByK = new Map(targets.map((k) => [k, [] as number[]]));
    const mrrs: number[] = [];

    for (const q of this.dataset.queries) {
      const retrieved = await retrievalFn(q.query);
      const relevant = new Set(q.relevantIds);

      for (const k of targets) {
        const topRetrieved = retrieved.slice(0, k);
        const hits = topRetrieved.filter((id) => relevant.has(id));
        const recall = relevant.size > 0 ? hits.length / relevant.size : 0;
        recallByK.get(k)?.push(recall);
      }

      // MRR = 1 / rank_of_first_relevant
      let mrr = 0;
      for (let i = 0; i < retrieved.length; i++) {
        if (relevant.has(retrieved[i])) {
          mrr = 1 / (i + 1);
          break;
        }
      }
      mrrs.push(mrr);
    }

    const average = (values: number[] | undefined): number =>
      values && values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const recallAt1 = average(recallByK.get(1));
    const recallAt5 = average(recallByK.get(5));
    const recallAt10 = average(recallByK.get(10));
    const avgRecall = average(recallByK.get(Math.max(...targets)));
    const avgMRR = mrrs.length > 0 ? mrrs.reduce((a, b) => a + b) / mrrs.length : 0;

    return {
      recallAt1,
      recallAt5,
      recallAt10,
      mrr: avgMRR,
      avgRecall,
    };
  }

  /**
   * Compute recall@k for a single query result.
   */
  static computeRecallAtK(relevant: Set<string>, retrieved: string[], k: number): number {
    const topK = retrieved.slice(0, k);
    const hits = topK.filter((id) => relevant.has(id)).length;
    return relevant.size > 0 ? hits / relevant.size : 0;
  }

  /**
   * Compute MRR (Mean Reciprocal Rank) for results.
   */
  static computeMRR(relevant: Set<string>, retrieved: string[]): number {
    for (let i = 0; i < retrieved.length; i++) {
      if (relevant.has(retrieved[i])) {
        return 1 / (i + 1);
      }
    }
    return 0;
  }

  getQueries(): EvalQuery[] {
    return this.dataset.queries;
  }

  getDatasetStats(): {
    totalQueries: number;
    avgRelevantPerQuery: number;
  } {
    const total = this.dataset.queries.length;
    const avgRelevant = this.dataset.queries.reduce((sum, q) => sum + q.relevantIds.length, 0) / total;
    return { totalQueries: total, avgRelevantPerQuery: avgRelevant };
  }
}
