import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { HybridRetrieval } from "./hybridRetrieval.js";
import { EvalHarness, type RecallMetrics } from "./evalHarness.js";
import type { BM25Store } from "./bm25Store.js";
import type { SQLiteVectorStore } from "./sqliteVectorStore.js";

interface ThresholdFile {
  floors: Pick<RecallMetrics, "recallAt1" | "recallAt5" | "recallAt10" | "mrr">;
}

const datasetPath = path.resolve(process.cwd(), "tests/memory/eval.dataset.json");
const thresholdPath = path.resolve(process.cwd(), "src/memory/eval.thresholds.json");

async function loadFixtures(): Promise<{
  harness: EvalHarness;
  thresholds: ThresholdFile;
  ids: string[];
}> {
  const [harness, rawThresholds] = await Promise.all([
    EvalHarness.loadAsync(datasetPath),
    fs.readFile(thresholdPath, "utf8"),
  ]);
  const ids = [...new Set(harness.getQueries().flatMap((query) => query.relevantIds))];
  return { harness, thresholds: JSON.parse(rawThresholds) as ThresholdFile, ids };
}

async function evaluate(useFusion: boolean): Promise<{ metrics: RecallMetrics; thresholds: ThresholdFile }> {
  const { harness, thresholds, ids } = await loadFixtures();
  const queries = new Map(harness.getQueries().map((query) => [query.query, query]));
  const bm25 = {
    search(query: string, topK = 10) {
      const relevant = queries.get(query)?.relevantIds ?? [];
      const decoys = ids.filter((id) => !relevant.includes(id)).slice(0, 5);
      return [...decoys, ...relevant].slice(0, topK).map((memoryId, index) => ({ memoryId, score: 1 / (index + 1) }));
    },
  } as unknown as BM25Store;
  let currentQuery = "";
  const vector = {
    search(_embedding: number[], topK = 10) {
      const relevant = queries.get(currentQuery)?.relevantIds ?? [];
      return relevant.slice(0, topK).map((memoryId, index) => ({ memoryId, score: 1 / (index + 1) }));
    },
  } as unknown as SQLiteVectorStore;
  const hybrid = new HybridRetrieval(vector, bm25);
  const metrics = await harness.evaluate(async (query) => {
    currentQuery = query;
    if (!useFusion) return hybrid.bm25Search(query, 10).map((result) => result.memoryId);
    return hybrid.search(query, [1], 10).map((result) => result.memoryId);
  });
  return { metrics, thresholds };
}

describe("memory retrieval evaluation gate", () => {
  test("committed HybridRetrieval baseline meets every floor", async () => {
    const { metrics, thresholds } = await evaluate(true);
    expect(metrics.recallAt1).toBeGreaterThanOrEqual(thresholds.floors.recallAt1);
    expect(metrics.recallAt5).toBeGreaterThanOrEqual(thresholds.floors.recallAt5);
    expect(metrics.recallAt10).toBeGreaterThanOrEqual(thresholds.floors.recallAt10);
    expect(metrics.mrr).toBeGreaterThanOrEqual(thresholds.floors.mrr);
  });

  test("deliberately disabling vector fusion falls below the committed floor", async () => {
    const { metrics, thresholds } = await evaluate(false);
    expect(metrics.recallAt5).toBeLessThan(thresholds.floors.recallAt5);
    expect(metrics.mrr).toBeLessThan(thresholds.floors.mrr);
  });
});
