import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "../memory/adapter.js";
import { McpMemoryAdapter } from "./mcp-clients.js";
import { ProcessSupervisor } from "./supervisor.js";
import type { MemoryPort, ProcessStatus } from "./ports.js";

function debugOrchestrator(message: string): void {
  if (process.env.ORACLE_DEBUG) console.debug(message);
}

/**
 * OrchestratorFactory creates memory adapters, preferring an MCP-backed server
 * and falling back to direct file storage when the server is unavailable.
 */
export class OrchestratorFactory {
  private supervisor: ProcessSupervisor;
  private rootDir: string;
  private memoryStatus: Map<string, ProcessStatus> = new Map();

  constructor(rootDir: string, homeDir?: string) {
    this.rootDir = rootDir;
    this.supervisor = new ProcessSupervisor(homeDir ?? path.join(os.homedir(), ".oracle"));
  }

  /**
   * Create a memory adapter — tries MCP-backed first, falls back to file-based.
   */
  async createMemoryAdapter(): Promise<MemoryPort> {
    const sessionKey = `mem-${Date.now()}`; // Session-scoped status

    try {
      const info = await this.supervisor.ensureRunning("memory");
      if (info) {
        this.memoryStatus.set(sessionKey, {
          transport: "mcp",
          endpoint: info.endpoint,
          pid: info.pid,
          port: info.port,
        });
        debugOrchestrator(`[orchestrator] memory: MCP backend ready at ${info.endpoint}`);
        try {
          return new McpMemoryAdapter(info.endpoint);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          debugOrchestrator(`[orchestrator] memory MCP client init failed: ${reason} — falling back to file adapter`);
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      debugOrchestrator(`[orchestrator] memory MCP spawn failed: ${reason}`);
    }

    // Fallback to file-based
    this.memoryStatus.set(sessionKey, {
      transport: "fallback",
      reason: "MCP server unavailable",
    });
    debugOrchestrator(`[orchestrator] memory: falling back to file adapter`);
    return new MemoryAdapter(this.rootDir);
  }


  /** Get the current memory adapter status for diagnostic/debugging. */
  getStatus(): ProcessStatus | null {
    const entries = Array.from(this.memoryStatus.entries());
    return entries.length > 0 ? entries[entries.length - 1][1] : null;
  }
}
