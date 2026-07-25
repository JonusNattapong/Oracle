import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeDatabase } from "./database.js";
import { CostTracker, estimateCostUSD } from "./costTracker.js";

describe("CostTracker", () => {
  let home: string;
  let database: RuntimeDatabase;
  let tracker: CostTracker;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-cost-"));
    database = new RuntimeDatabase(home);
    tracker = new CostTracker(database.connection);
  });

  afterEach(async () => {
    database.close();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  test("estimates cost from the price table by longest matching prefix", () => {
    // claude-haiku ($0.8/$4 per 1M) must not fall through to the generic claude row.
    const haiku = estimateCostUSD("anthropic", "claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(haiku).toBeCloseTo(4.8, 5);

    const sonnet = estimateCostUSD("anthropic", "claude-sonnet-5", 1_000_000, 0);
    expect(sonnet).toBeCloseTo(3, 5);
  });

  test("local providers are free and unknown models cost zero rather than guessing", () => {
    expect(estimateCostUSD("ollama", "mistral", 5_000_000, 5_000_000)).toBe(0);
    expect(estimateCostUSD("anthropic", "some-unreleased-model", 1_000_000, 0)).toBe(0);
  });

  test("aggregates totals split by provider and agent", () => {
    tracker.log({ provider: "anthropic", model: "claude-sonnet-5", agent: "planner", inputTokens: 1000, outputTokens: 500 });
    tracker.log({ provider: "anthropic", model: "claude-sonnet-5", agent: "planner", inputTokens: 2000, outputTokens: 1000 });
    tracker.log({ provider: "openai", model: "gpt-4o", agent: "reviewer", inputTokens: 1000, outputTokens: 1000 });

    const summary = tracker.summary("today");
    expect(summary.calls).toBe(3);
    expect(summary.totalTokens).toBe(6500);
    expect(summary.byProvider.anthropic.calls).toBe(2);
    expect(summary.byProvider.anthropic.tokens).toBe(4500);
    expect(summary.byAgent.planner.tokens).toBe(4500);
    expect(summary.byAgent.reviewer.tokens).toBe(2000);
    expect(summary.totalCostUSD).toBeGreaterThan(0);
    expect(summary.avgCostPerCall).toBeCloseTo(summary.totalCostUSD / 3, 10);
  });

  test("calls without an agent are attributed explicitly, not dropped", () => {
    tracker.log({ provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 100 });
    const summary = tracker.summary("today");
    expect(summary.calls).toBe(1);
    expect(summary.byAgent["(unattributed)"].tokens).toBe(200);
  });

  test("filters by agent when asked", () => {
    tracker.log({ provider: "anthropic", model: "claude-sonnet-5", agent: "a", inputTokens: 100, outputTokens: 0 });
    tracker.log({ provider: "anthropic", model: "claude-sonnet-5", agent: "b", inputTokens: 900, outputTokens: 0 });

    const onlyA = tracker.summary("today", { agent: "a" });
    expect(onlyA.calls).toBe(1);
    expect(onlyA.totalTokens).toBe(100);
  });

  test("an explicit costUSD overrides the price table", () => {
    tracker.log({ provider: "custom", model: "unknown", inputTokens: 10, outputTokens: 10, costUSD: 42 });
    expect(tracker.summary("today").totalCostUSD).toBe(42);
  });

  test("checkBudget reports ok, warn, and exceeded", () => {
    tracker.log({ provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 0 }); // $3

    expect(tracker.checkBudget(100).level).toBe("ok");
    expect(tracker.checkBudget(3.5).level).toBe("warn");
    expect(tracker.checkBudget(2).level).toBe("exceeded");
  });

  test("prune removes rows older than the retention window", () => {
    tracker.log({ provider: "openai", model: "gpt-4o", inputTokens: 10, outputTokens: 10 });
    database.connection
      .prepare("UPDATE cost_log SET created_at = ?")
      .run(new Date(Date.now() - 200 * 86_400_000).toISOString());

    expect(tracker.prune(90)).toBe(1);
    expect(tracker.summary("all").calls).toBe(0);
  });

  test("window filtering excludes rows outside the range", () => {
    tracker.log({ provider: "openai", model: "gpt-4o", inputTokens: 10, outputTokens: 10 });
    database.connection
      .prepare("UPDATE cost_log SET created_at = ?")
      .run(new Date(Date.now() - 10 * 86_400_000).toISOString());

    expect(tracker.summary("today").calls).toBe(0);
    expect(tracker.summary("week").calls).toBe(0);
    expect(tracker.summary("month").calls).toBe(1);
    expect(tracker.summary("all").calls).toBe(1);
  });
});
