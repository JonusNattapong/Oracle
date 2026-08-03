import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "../memory/adapter.js";
import { ChatGptMemoryAdapter } from "../memory/chatgptMemoryAdapter.js";
import { HybridMemoryAdapter } from "../memory/hybridMemoryAdapter.js";
import { loadProjectConfig, type MemoryConfig } from "../config/project.js";
import { createExecutionBackend } from "../providers/factory.js";
import type { ExecutionBackend } from "../backends/backend.js";
import type { MemoryPort } from "./ports.js";

export interface OrchestratorFactoryOptions {
  /** Overrides the memory section of .oracle/config.json (used by tests). */
  memory?: MemoryConfig;
  /** Injected so tests can supply a fake ChatGPT backend. */
  backendFactory?: (homeDir: string) => ExecutionBackend;
}

/**
 * OrchestratorFactory builds the memory adapter for the configured store:
 * `local` (default), `chatgpt` (account Saved Memory), or `hybrid`.
 *
 * Local memory is written directly to `.oracle-memory/`. Earlier versions first
 * tried to spawn an `oracle-memory` MCP sidecar and fell back to the same file
 * adapter when it was absent; that package is retired, and the file adapter
 * always owned the on-disk format, so the sidecar path was removed rather than
 * left attempting a spawn that could only fail.
 */
export class OrchestratorFactory {
  private rootDir: string;
  private homeDir: string;
  private options: OrchestratorFactoryOptions;

  constructor(rootDir: string, homeDir?: string, options: OrchestratorFactoryOptions = {}) {
    this.rootDir = rootDir;
    this.homeDir = homeDir ?? path.join(os.homedir(), ".oracle");
    this.options = options;
  }

  /**
   * Create the memory adapter for the configured store. `chatgpt` and `hybrid`
   * both build on the local adapter — as remote shadow index and as canonical
   * store respectively — so a broken browser session degrades to local memory
   * instead of losing writes.
   */
  async createMemoryAdapter(): Promise<MemoryPort> {
    const config = this.options.memory ?? (await this.loadMemoryConfig());
    const local = new MemoryAdapter(this.rootDir);
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
}
