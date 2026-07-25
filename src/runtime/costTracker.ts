import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Cost & token accounting across provider calls.
 *
 * Providers already report per-call token usage; this records it so a swarm
 * can answer "what did today cost, and which agent spent it?".
 */

export type CostWindow = "today" | "week" | "month" | "all";

export interface CostEntry {
  provider: string;
  model: string;
  agent?: string;
  inputTokens: number;
  outputTokens: number;
  /** Omit to derive from the built-in price table. */
  costUSD?: number;
}

export interface CostBreakdown {
  tokens: number;
  costUSD: number;
  calls: number;
}

export interface CostSummary {
  window: CostWindow;
  since: string | null;
  totalTokens: number;
  totalCostUSD: number;
  calls: number;
  avgCostPerCall: number;
  byProvider: Record<string, CostBreakdown>;
  byAgent: Record<string, CostBreakdown>;
}

interface CostRow {
  provider: string;
  model: string;
  agent: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/**
 * USD per 1M tokens, keyed by a model-name prefix. Longest prefix wins, so
 * "claude-opus-4" beats the generic "claude-" fallback.
 */
const PRICE_TABLE: Array<{ prefix: string; input: number; output: number }> = [
  { prefix: "claude-opus", input: 15, output: 75 },
  { prefix: "claude-sonnet", input: 3, output: 15 },
  { prefix: "claude-haiku", input: 0.8, output: 4 },
  { prefix: "claude-3-opus", input: 15, output: 75 },
  { prefix: "claude-3-5-sonnet", input: 3, output: 15 },
  { prefix: "claude-3-haiku", input: 0.25, output: 1.25 },
  { prefix: "claude", input: 3, output: 15 },
  { prefix: "gpt-4o-mini", input: 0.15, output: 0.6 },
  { prefix: "gpt-4o", input: 2.5, output: 10 },
  { prefix: "gpt-4", input: 30, output: 60 },
  { prefix: "gpt-3.5", input: 0.5, output: 1.5 },
  { prefix: "o1-mini", input: 3, output: 12 },
  { prefix: "o1", input: 15, output: 60 },
  { prefix: "gemini-2.0-flash", input: 0.1, output: 0.4 },
  { prefix: "gemini-2.0-pro", input: 1.25, output: 5 },
  { prefix: "gemini-1.5-flash", input: 0.075, output: 0.3 },
  { prefix: "gemini", input: 1.25, output: 5 },
];

/** Local models cost nothing to run; keep them at zero rather than guessing. */
const FREE_PROVIDERS = new Set(["ollama", "local"]);

/**
 * Estimate USD for a call. Unknown models return 0 — an unknown price is
 * reported as unknown rather than silently invented.
 */
export function estimateCostUSD(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  if (FREE_PROVIDERS.has(provider.toLowerCase())) return 0;
  const name = model.toLowerCase();
  let best: { prefix: string; input: number; output: number } | undefined;
  for (const row of PRICE_TABLE) {
    if (!name.includes(row.prefix)) continue;
    if (!best || row.prefix.length > best.prefix.length) best = row;
  }
  if (!best) return 0;
  return (inputTokens / 1_000_000) * best.input + (outputTokens / 1_000_000) * best.output;
}

function windowStart(window: CostWindow, now = new Date()): string | null {
  if (window === "all") return null;
  const d = new Date(now);
  if (window === "today") {
    d.setHours(0, 0, 0, 0);
  } else if (window === "week") {
    d.setDate(d.getDate() - 7);
  } else {
    d.setDate(d.getDate() - 30);
  }
  return d.toISOString();
}

export class CostTracker {
  constructor(private readonly connection: DatabaseSync) {}

  /** Record one provider call. Never throws — accounting must not break a consult. */
  log(entry: CostEntry): void {
    const inputTokens = Math.max(0, Math.round(entry.inputTokens || 0));
    const outputTokens = Math.max(0, Math.round(entry.outputTokens || 0));
    const costUSD =
      entry.costUSD ?? estimateCostUSD(entry.provider, entry.model, inputTokens, outputTokens);
    try {
      this.connection
        .prepare(
          `INSERT INTO cost_log (id, provider, model, agent, input_tokens, output_tokens, cost_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          entry.provider,
          entry.model,
          entry.agent ?? null,
          inputTokens,
          outputTokens,
          costUSD,
          new Date().toISOString()
        );
    } catch {
      /* accounting is best-effort; a failed insert must not fail the caller */
    }
  }

  /** Aggregate spend over a window, split by provider and agent. */
  summary(window: CostWindow = "today", opts?: { agent?: string }): CostSummary {
    const since = windowStart(window);
    const filters: string[] = [];
    const params: Array<string> = [];
    if (since) {
      filters.push("created_at >= ?");
      params.push(since);
    }
    if (opts?.agent) {
      filters.push("agent = ?");
      params.push(opts.agent);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const rows = this.connection
      .prepare(
        `SELECT provider, model, agent, input_tokens, output_tokens, cost_usd
         FROM cost_log ${where}`
      )
      .all(...params) as unknown as CostRow[];

    const byProvider: Record<string, CostBreakdown> = {};
    const byAgent: Record<string, CostBreakdown> = {};
    let totalTokens = 0;
    let totalCostUSD = 0;

    for (const row of rows) {
      const tokens = row.input_tokens + row.output_tokens;
      totalTokens += tokens;
      totalCostUSD += row.cost_usd;
      add(byProvider, row.provider, tokens, row.cost_usd);
      add(byAgent, row.agent ?? "(unattributed)", tokens, row.cost_usd);
    }

    return {
      window,
      since,
      totalTokens,
      totalCostUSD,
      calls: rows.length,
      avgCostPerCall: rows.length ? totalCostUSD / rows.length : 0,
      byProvider,
      byAgent,
    };
  }

  /**
   * Check a spend ceiling for the window.
   * `warnAt` is a fraction (0.8 = warn once 80% of the budget is gone).
   */
  checkBudget(
    limitUSD: number,
    window: CostWindow = "today",
    warnAt = 0.8
  ): { level: "ok" | "warn" | "exceeded"; spentUSD: number; limitUSD: number; message: string } {
    const { totalCostUSD } = this.summary(window);
    const ratio = limitUSD > 0 ? totalCostUSD / limitUSD : 0;
    const spent = `$${totalCostUSD.toFixed(2)} of $${limitUSD.toFixed(2)} (${window})`;
    if (ratio >= 1) {
      return { level: "exceeded", spentUSD: totalCostUSD, limitUSD, message: `Budget exceeded: ${spent}` };
    }
    if (ratio >= warnAt) {
      return { level: "warn", spentUSD: totalCostUSD, limitUSD, message: `Budget ${Math.round(ratio * 100)}% used: ${spent}` };
    }
    return { level: "ok", spentUSD: totalCostUSD, limitUSD, message: `Within budget: ${spent}` };
  }

  /** Drop rows older than `days`. Returns how many were removed. */
  prune(days = 90): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = this.connection.prepare("DELETE FROM cost_log WHERE created_at < ?").run(cutoff);
    return Number(result.changes ?? 0);
  }
}

function add(target: Record<string, CostBreakdown>, key: string, tokens: number, costUSD: number): void {
  const current = target[key] ?? { tokens: 0, costUSD: 0, calls: 0 };
  current.tokens += tokens;
  current.costUSD += costUSD;
  current.calls += 1;
  target[key] = current;
}
