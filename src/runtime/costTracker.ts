/**
 * Cost & Token Tracking for v0.7.0
 * Aggregates provider costs, supports per-agent breakdown, alert thresholds.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostEntry {
  callId: string;
  provider: string; // "anthropic" | "openai" | "gemini" | "bedrock" | "vertex" | "ollama"
  model: string;
  tokens: TokenUsage;
  costUSD: number;
  createdAt: string;
  agent?: string;
}

export interface CostSummary {
  totalTokens: number;
  totalCostUSD: number;
  byProvider: Record<string, { tokens: number; costUSD: number }>;
  byAgent: Record<string, { tokens: number; costUSD: number }>;
  callCount: number;
  avgCostPerCall: number;
}

/**
 * Tracks costs across all provider calls.
 * TODO: Implement in v0.7.0
 * - Connect to RuntimeDatabase cost_log table
 * - Aggregate by day/week/month
 * - Per-agent breakdown
 * - Alert thresholds
 */
export class CostTracker {
  constructor(private db: any) {} // TODO: RuntimeDatabase

  async logCall(entry: CostEntry): Promise<void> {
    // TODO: INSERT into cost_log table
  }

  async getSummary(window: "today" | "week" | "month"): Promise<CostSummary> {
    // TODO: Query cost_log, aggregate, return
    throw new Error("Not implemented in v0.6.0 — planned for v0.7.0");
  }

  async getByAgent(agent: string, window?: string): Promise<CostSummary> {
    // TODO: Per-agent breakdown
    throw new Error("Not implemented in v0.6.0 — planned for v0.7.0");
  }

  async checkAlerts(threshold: number): Promise<{ exceeded: boolean; message?: string }> {
    // TODO: Check if today's spend exceeds threshold
    throw new Error("Not implemented in v0.6.0 — planned for v0.7.0");
  }
}
