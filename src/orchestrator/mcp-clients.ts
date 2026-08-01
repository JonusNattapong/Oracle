import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { MemoryPort } from "./ports.js";
import type { MemoryStoreEntry, MemoryType } from "../memory/adapter.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; [key: string]: unknown };

/**
 * McpMemoryAdapter wraps the oracle-memory MCP server via HTTP StreamableHTTPClientTransport.
 */
export class McpMemoryAdapter implements MemoryPort {
  private client: Client;
  private url: URL;
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(endpoint: string) {
    this.url = new URL(endpoint);
    this.client = new Client(
      { name: "oracle-cli", version: "0.1.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } }
    );
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    // Concurrent calls (e.g. parallel remember/recall) must share one connect
    // attempt instead of racing multiple `client.connect()` calls on the same client.
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const transport = new StreamableHTTPClientTransport(this.url);
        await this.client.connect(transport);
        this.connected = true;
      } catch (err) {
        throw new Error(`Failed to connect to oracle-memory at ${this.url}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private extractText(result: ToolResult): string {
    const textContent = result.content.find((c) => c.type === "text");
    if (!textContent || !textContent.text) throw new Error("No text response from server");
    return textContent.text;
  }

  async remember(
    agent: string,
    type: MemoryType,
    content: string,
    opts?: { tags?: string[]; meta?: Record<string, unknown>; importance?: number }
  ): Promise<MemoryStoreEntry> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "remember",
      arguments: {
        agent,
        type,
        content,
        tags: opts?.tags,
        importance: opts?.importance,
      },
    })) as ToolResult;

    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success) throw new Error(parsed.error || "remember failed");
      return parsed.memory as MemoryStoreEntry;
    } catch (err) {
      throw new Error(`Failed to parse remember response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async recall(opts?: { type?: MemoryType; agent?: string; tags?: string[]; limit?: number; includeArchived?: boolean }): Promise<MemoryStoreEntry[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "recall",
      arguments: {
        query: "*",
        type: opts?.type,
        agent: opts?.agent,
        tags: opts?.tags,
        limit: Math.min(opts?.limit ?? 20, 200),
        // the oracle-memory MCP server's equivalent knob is named includeExpired,
        // not includeArchived — same "don't hide superseded/archived entries" intent
        includeExpired: opts?.includeArchived,
      },
    })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success) throw new Error(parsed.error || "recall failed");
      return (parsed.results || []) as MemoryStoreEntry[];
    } catch (err) {
      throw new Error(`Failed to parse recall response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async searchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }): Promise<MemoryStoreEntry[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "recall",
      arguments: {
        query,
        type: opts?.type,
        agent: opts?.agent,
        limit: Math.min(opts?.limit ?? 50, 200),
      },
    })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success) throw new Error(parsed.error || "search failed");
      return (parsed.results || []) as MemoryStoreEntry[];
    } catch (err) {
      throw new Error(`Failed to parse search response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async scoredSearchMemories(query: string, opts?: { type?: MemoryType; agent?: string; limit?: number }): Promise<MemoryStoreEntry[]> {
    // Delegate to the MCP server's recall tool — scoring is done server-side
    return this.searchMemories(query, opts);
  }

  async updateMemory(id: string, type: MemoryType, updates: { content?: string; tags?: string[]; importance?: number }): Promise<MemoryStoreEntry | null> {
    await this.ensureConnected();
    try {
      const result = (await this.client.callTool({
        name: "remember",
        arguments: {
          entry_id: id,
          type,
          agent: "oracle",
          content: updates.content ?? "",
          tags: updates.tags,
          importance: updates.importance,
        },
      })) as ToolResult;
      const text = this.extractText(result);
      try {
        const parsed = JSON.parse(text);
        if (!parsed.success) return null;
        return parsed.memory as MemoryStoreEntry;
      } catch (err) {
        console.error(`[oracle-memory] Failed to parse update response: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    } catch (err) {
      console.error(`[oracle-memory] Update operation failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async getStats(): Promise<{ total: number; byType: Record<string, number>; byAgent: Record<string, number> }> {
    const all = await this.recall({ limit: 10_000 });
    const byType: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    for (const e of all) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      byAgent[e.agent] = (byAgent[e.agent] ?? 0) + 1;
    }
    return { total: all.length, byType, byAgent };
  }

  async forget(id: string, type: MemoryType): Promise<void> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "forget",
      arguments: { id, type },
    })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success) throw new Error(parsed.error || "forget failed");
    } catch (err) {
      throw new Error(`Failed to parse forget response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async clearWorking(agent?: string): Promise<number> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "forget",
      arguments: { agent: agent ?? "" },
    })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success) throw new Error(parsed.error || "clear_working failed");
      return parsed.cleared as number;
    } catch (err) {
      throw new Error(`Failed to parse clear_working response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Advanced methods delegated to oracle-memory server ──────────

  async graphQuery(query: string, opts?: { agent?: string; limit?: number }): Promise<MemoryStoreEntry[]> {
    // oracle-memory server supports graph query via recall with graph_query param
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "recall",
      arguments: {
        graph_query: query,
        agent: opts?.agent,
        limit: Math.min(opts?.limit ?? 20, 200),
      },
    })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success) return [];
      return (parsed.results || []) as MemoryStoreEntry[];
    } catch (err) {
      console.error(`[oracle-memory] Failed to parse graph query response: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async consolidate(): Promise<{ consolidated: number; created: MemoryStoreEntry | null; archived: string[] }> {
    await this.ensureConnected();
    const result = (await this.client.callTool({ name: "consolidate", arguments: {} })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      if (!parsed.success) return { consolidated: 0, created: null, archived: [] };
      return { consolidated: parsed.consolidated ?? 0, created: parsed.created ?? null, archived: parsed.archived ?? [] };
    } catch (err) {
      console.error(`[oracle-memory] Failed to parse consolidate response: ${err instanceof Error ? err.message : String(err)}`);
      return { consolidated: 0, created: null, archived: [] };
    }
  }

  async pruneStale(opts?: { minImportance?: number; minStaleDays?: number }): Promise<string[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "prune_memories",
      arguments: { min_importance: opts?.minImportance, min_stale_days: opts?.minStaleDays },
    })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      return (parsed.memories || []).map((m: any) => m.id);
    } catch (err) {
      console.error(`[oracle-memory] Failed to parse prune response: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async promoteWorking(opts?: { minAccessCount?: number }): Promise<string[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({
      name: "promote_memory",
      arguments: { min_access_count: opts?.minAccessCount },
    })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      return (parsed.memories || []).map((m: any) => m.id);
    } catch (err) {
      console.error(`[oracle-memory] Failed to parse promote response: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async runMaintenance(opts?: { minImportance?: number; minStaleDays?: number; minAccessCount?: number }): Promise<{ pruned: string[]; promoted: string[] }> {
    const [pruned, promoted] = await Promise.all([
      this.pruneStale({ minImportance: opts?.minImportance, minStaleDays: opts?.minStaleDays }),
      this.promoteWorking({ minAccessCount: opts?.minAccessCount }),
    ]);
    return { pruned, promoted };
  }

  async reflect(opts?: { agent?: string }): Promise<{ content: string; tags: string[]; confidence: number; sourceIds: string[] }[]> {
    await this.ensureConnected();
    const result = (await this.client.callTool({ name: "reflect", arguments: { agent: opts?.agent ?? "oracle" } })) as ToolResult;
    const text = this.extractText(result);
    try {
      const parsed = JSON.parse(text);
      return (parsed.memories || []) as any[];
    } catch (err) {
      console.error(`[oracle-memory] Failed to parse reflect response: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
}
