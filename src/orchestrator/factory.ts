import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "../memory/adapter.js";
import { ChatGptMemoryAdapter } from "../memory/chatgptMemoryAdapter.js";
import { HybridMemoryAdapter } from "../memory/hybridMemoryAdapter.js";
import { loadProjectConfig, type MemoryConfig } from "../config/project.js";
import { createExecutionBackend } from "../providers/factory.js";
import type { ExecutionBackend } from "../backends/backend.js";
import { McpMemoryAdapter } from "./mcp-clients.js";
import { ProcessSupervisor } from "./supervisor.js";
import type { MemoryPort, ProcessStatus } from "./ports.js";

function debugOrchestrator(message: string): void {
  if (process.env.ORACLE_DEBUG) console.debug(message);
}

export interface OrchestratorFactoryOptions {
  /** Overrides the memory section of .oracle/config.json (used by tests). */
  memory?: MemoryConfig;
  /** Injected so tests can supply a fake ChatGPT backend. */
  backendFactory?: (homeDir: string) => ExecutionBackend;
}

/**
 * OrchestratorFactory creates memory adapters, preferring an MCP-backed server
 * and falling back to direct file storage when the server is unavailable.
 *
 * Where memory ultimately lives is a config decision (`memory.store`):
 * `local` (default), `chatgpt` (account Saved Memory), or `hybrid`.
 */
export class OrchestratorFactory {
  private supervisor: ProcessSupervisor;
  private rootDir: string;
  private homeDir: string;
  private options: OrchestratorFactoryOptions;
  private memoryStatus: Map<string, ProcessStatus> = new Map();

  constructor(rootDir: string, homeDir?: string, options: OrchestratorFactoryOptions = {}) {
    this.rootDir = rootDir;
    this.homeDir = homeDir ?? path.join(os.homedir(), ".oracle");
    this.options = options;
    this.supervisor = new ProcessSupervisor(this.homeDir);
  }

  /**
   * Create the memory adapter for the configured store. `chatgpt` and `hybrid`
   * both build on the local adapter — as remote shadow index and as canonical
   * store respectively — so a broken browser session degrades to local memory
   * instead of losing writes.
   */
  async createMemoryAdapter(): Promise<MemoryPort> {
    const config = this.options.memory ?? (await this.loadMemoryConfig());
    const local = await this.createLocalAdapter();
    if (config.store === "local") return local;

    let backend: ExecutionBackend;
    try {
      backend = this.options.backendFactory
        ? this.options.backendFactory(this.homeDir)
        : createExecutionBackend(config.remoteBackend, {
            homeDir: this.homeDir,
            experimentalBrowserMode: true,
            browser: { profileDir: path.join(this.homeDir, "chrome-profile") }
          });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[memory] store "${config.store}" needs backend "${config.remoteBackend}", which failed to start (${reason}). Using local memory.`
      );
      return local;
    }

    if (!backend.capabilities.accountMemory) {
      console.warn(
        `[memory] backend "${backend.id}" cannot write ChatGPT account memory. Using local memory.`
      );
      return local;
    }

    if (config.store === "chatgpt") {
      return new ChatGptMemoryAdapter({
        backend,
        shadow: local,
        cacheTtlMinutes: config.remoteCacheTtlMinutes,
        cwd: this.rootDir
      });
    }

    return new HybridMemoryAdapter({
      local,
      backend,
      mirror: config.mirror,
      cwd: this.rootDir
    });
  }

  private async loadMemoryConfig(): Promise<MemoryConfig> {
    try {
      return (await loadProjectConfig(this.rootDir)).memory;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[memory] could not read .oracle/config.json (${reason}). Using local memory.`);
      return {
        store: "local",
        remoteBackend: "chatgpt-browser",
        remoteCacheTtlMinutes: 10,
        mirror: { minImportance: 0.7, types: ["fact", "insight"] }
      };
    }
  }

  /**
   * The local adapter — MCP-backed sidecar when available, file-based otherwise.
   */
  private async createLocalAdapter(): Promise<MemoryPort> {
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
