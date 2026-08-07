/**
 * Reflective insight synthesis for the Oracle memory system.
 *
 * Takes clusters of related memories and asks an LLM (Anthropic) to distill
 * NEW higher-level insights that none of them state outright. Requires
 * ANTHROPIC_API_KEY and ORACLE_MEMORY_LLM_GRAPH=1 (or explicit opts).
 */
import type { MemoryStoreEntry } from "./adapter.js";

export interface Reflection {
  content: string;
  tags: string[];
  confidence: number;
  sourceIds: string[];
}

export interface ReflectOptions {
  apiKey?: string;
  model?: string;
  maxMemories?: number;
  minConfidence?: number;
}

const DEFAULT_MODEL = "claude-opus-4-8";

const REFLECTION_SYSTEM = `You are the reflective memory of an AI coding agent.
Given a cluster of related memories, synthesize higher-level INSIGHTS that are
not stated verbatim in any single memory but emerge from the pattern across
them. Rules:
- Each insight must be genuinely new synthesis, not a restatement or summary.
- Prefer actionable lessons, causal links, and generalizations.
- Be conservative: if the memories don't support a real generalization, return
  fewer insights (or none). Do not invent facts.
- Cite the memory ids each insight draws from.`;

/**
 * Cluster memories by tag overlap (Jaccard ≥ 0.25), then reflect on each
 * cluster using the Anthropic API.
 *
 * Requires ANTHROPIC_API_KEY. Returns an empty array if no key is available
 * or no clusters produce insights.
 */
export async function reflectOnMemories(
  entries: MemoryStoreEntry[],
  opts: ReflectOptions = {},
): Promise<Reflection[]> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const usable = entries.filter((e) => !e.archived && !e.pruned);
  const clusters = clusterByTags(usable, 0.25);

  const model = opts.model ?? DEFAULT_MODEL;
  const maxMemories = opts.maxMemories ?? 40;
  const minConfidence = opts.minConfidence ?? 0.5;
  const allInsights: Reflection[] = [];

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const slice = cluster.slice(0, maxMemories);

    const list = slice
      .map((m) => `- id=${m.id} [${m.type}]${m.tags.length ? ` (${m.tags.join(", ")})` : ""}: ${m.content.replace(/\s+/g, " ").slice(0, 600)}`)
      .join("\n");

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: REFLECTION_SYSTEM,
          messages: [{ role: "user", content: `Memories:\n${list}` }],
        }),
      });

      if (!response.ok) continue;

      const data = (await response.json()) as any;
      if (data.stop_reason === "refusal") continue;

      const textBlock = data.content?.find((b: any) => b.type === "text");
      if (!textBlock?.text) continue;

      // Try to parse JSON from the response
      let parsed: { insights?: Reflection[] } | null = null;
      try {
        const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch { /* skip unparseable */ }

      if (parsed?.insights) {
        for (const insight of parsed.insights) {
          if (insight.confidence >= minConfidence) {
            allInsights.push(insight);
          }
        }
      }
    } catch {
      // Network errors are non-fatal
    }
  }

  return allInsights;
}

/**
 * Group entries by tag overlap (Jaccard similarity).
 */
function clusterByTags(entries: MemoryStoreEntry[], threshold: number): MemoryStoreEntry[][] {
  const clusters: MemoryStoreEntry[][] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    if (assigned.has(entries[i].id)) continue;
    const cluster = [entries[i]];
    assigned.add(entries[i].id);

    for (let j = i + 1; j < entries.length; j++) {
      if (assigned.has(entries[j].id)) continue;
      const sim = jaccard(entries[i].tags, entries[j].tags);
      if (sim >= threshold) {
        cluster.push(entries[j]);
        assigned.add(entries[j].id);
      }
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map((t) => t.toLowerCase()));
  const setB = new Set(b.map((t) => t.toLowerCase()));
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : inter / union.size;
}
