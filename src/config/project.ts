import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { OracleError } from "../errors.js";
import type { BackendName, ProviderName, ProviderSelection } from "../providers/factory.js";

export interface McpServerConfig {
  name: string;
  /** stdio server: command + args */
  command?: string;
  args?: string[];
  /** HTTP/SSE server: endpoint URL */
  url?: string;
  /** If true, tools from this server may mutate the workspace; otherwise read-only. Default: false. */
  trustedForMutation?: boolean;
}

/**
 * Where durable memory lives.
 * - `local`  — this machine only (SQLite/file store, optionally via the
 *   oracle-memory MCP sidecar). Full fidelity: ids, tags, importance, search.
 * - `chatgpt` — the signed-in ChatGPT account's Saved Memory is the store.
 *   Requires the `chatgpt-browser` backend. Saved Memory has no ids, tags,
 *   timestamps, or reliable ordering, so this mode is best-effort: entries are
 *   shadow-indexed locally to keep the MemoryPort contract usable.
 * - `hybrid` — local is canonical; entries matching the mirror policy are also
 *   pushed to ChatGPT Saved Memory so web conversations share the context.
 */
export type MemoryStoreMode = "local" | "chatgpt" | "hybrid";

export interface MemoryMirrorConfig {
  /** Only mirror entries at or above this importance (0–1). */
  minImportance: number;
  /** Only mirror these memory types. */
  types: Array<"fact" | "insight" | "chunk" | "working">;
  /** When set, an entry must also carry at least one of these tags. */
  tags?: string[];
}

export interface MemoryConfig {
  store: MemoryStoreMode;
  /** Backend used to reach ChatGPT Saved Memory in `chatgpt`/`hybrid` mode. */
  remoteBackend: "chatgpt-browser";
  /** How long a remote Saved Memory read is reused before re-querying. */
  remoteCacheTtlMinutes: number;
  mirror: MemoryMirrorConfig;
}

export interface ProjectConfig {
  backend: BackendName;
  provider: ProviderSelection;
  model: string;
  include: string[];
  exclude: string[];
  maxFileSizeBytes: number;
  maxInputBytes: number;
  mcpServers?: McpServerConfig[];
  memory: MemoryConfig;
  experimental?: {
    browserMode?: boolean;
  };
  browser: {
    profileDir?: string;
    timeoutMs?: number;
    model: string;
    manualLogin: boolean;
    attachRunning: boolean;
    remoteChrome?: string;
    remoteHost?: string;
    chatgptUrl?: string;
    modelStrategy: "select" | "current" | "ignore";
    tab?: string;
    thinkingTime?: "light" | "standard" | "extended" | "heavy";
    research?: "deep";
    followUps: string[];
    archive: "auto" | "always" | "never";
    attachments: "auto" | "never" | "always";
    bundleFiles: boolean;
    bundleFormat: "auto" | "text" | "zip";
    port?: string;
    timeout: string;
    inputTimeout: string;
    attachmentTimeout: string;
    recheckDelay?: string;
    recheckTimeout?: string;
    heartbeat?: string;
    reuseWait?: string;
    profileLockTimeout?: string;
    maxConcurrentTabs: number;
    hideWindow: boolean;
    autoReattachDelay: string;
    autoReattachInterval: string;
    autoReattachTimeout: string;
  };
  worker: {
    pollInterval: string;
    heartbeat: string;
    staleAfter: string;
    retryDelay: string;
    maxAttempts: number;
  };
  azure: {
    endpoint?: string;
    deployment?: string;
    apiVersion?: string;
  };
  openrouter: {
    baseURL: string;
    siteUrl?: string;
    appName?: string;
  };
  routing: {
    defaultProvider: ProviderName;
    preferAzure: boolean;
  };
  serve: {
    host: string;
    port: number;
    manualLogin: boolean;
    profileDir?: string;
  };
}

const browserSchema = z
  .object({
    profileDir: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
    model: z.string().trim().min(1).optional(),
    manualLogin: z.boolean().optional(),
    attachRunning: z.boolean().optional(),
    remoteChrome: z.string().trim().min(1).optional(),
    remoteHost: z.string().trim().min(1).optional(),
    chatgptUrl: z.string().url().optional(),
    modelStrategy: z.enum(["select", "current", "ignore"]).optional(),
    tab: z.string().trim().min(1).optional(),
    thinkingTime: z.enum(["light", "standard", "extended", "heavy"]).optional(),
    research: z.literal("deep").optional(),
    followUps: z.array(z.string().trim().min(1)).optional(),
    archive: z.enum(["auto", "always", "never"]).optional(),
    attachments: z.enum(["auto", "never", "always"]).optional(),
    bundleFiles: z.boolean().optional(),
    bundleFormat: z.enum(["auto", "text", "zip"]).optional(),
    port: z.string().trim().min(1).optional(),
    timeout: z.string().trim().min(1).optional(),
    inputTimeout: z.string().trim().min(1).optional(),
    attachmentTimeout: z.string().trim().min(1).optional(),
    recheckDelay: z.string().trim().min(1).optional(),
    recheckTimeout: z.string().trim().min(1).optional(),
    heartbeat: z.string().trim().min(1).optional(),
    reuseWait: z.string().trim().min(1).optional(),
    profileLockTimeout: z.string().trim().min(1).optional(),
    maxConcurrentTabs: z.number().int().positive().optional(),
    hideWindow: z.boolean().optional(),
    autoReattachDelay: z.string().trim().min(1).optional(),
    autoReattachInterval: z.string().trim().min(1).optional(),
    autoReattachTimeout: z.string().trim().min(1).optional(),
  })
  .strict();

const memorySchema = z
  .object({
    store: z.enum(["local", "chatgpt", "hybrid"]).optional(),
    remoteBackend: z.literal("chatgpt-browser").optional(),
    remoteCacheTtlMinutes: z.number().int().min(0).max(1_440).optional(),
    mirror: z
      .object({
        minImportance: z.number().min(0).max(1).optional(),
        types: z
          .array(z.enum(["fact", "insight", "chunk", "working"]))
          .min(1)
          .optional(),
        tags: z.array(z.string().trim().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const workerSchema = z
  .object({
    pollInterval: z.string().trim().min(1).optional(),
    heartbeat: z.string().trim().min(1).optional(),
    staleAfter: z.string().trim().min(1).optional(),
    retryDelay: z.string().trim().min(1).optional(),
    maxAttempts: z.number().int().positive().optional(),
  })
  .strict();

const azureSchema = z
  .object({
    endpoint: z.string().url().optional(),
    deployment: z.string().trim().min(1).optional(),
    apiVersion: z.string().trim().min(1).optional(),
  })
  .strict();

const openrouterSchema = z
  .object({
    baseURL: z.string().url().optional(),
    siteUrl: z.string().url().optional(),
    appName: z.string().trim().min(1).optional(),
  })
  .strict();

const providerValues = [
  "codex",
  "openai",
  "anthropic",
  "opencode",
  "gemini",
  "browser",
  "chatgpt-browser",
  "azure",
  "openrouter",
] as const;

const routingSchema = z
  .object({
    defaultProvider: z.enum(providerValues).optional(),
    preferAzure: z.boolean().optional(),
  })
  .strict();

const serveSchema = z
  .object({
    host: z.string().trim().min(1).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    manualLogin: z.boolean().optional(),
    profileDir: z.string().trim().min(1).optional(),
  })
  .strict();

const schema = z
  .object({
    backend: z.enum(providerValues).optional(),
    provider: z.enum([...providerValues, "auto"]).optional(),
    model: z.string().trim().min(1).optional(),
    include: z.array(z.string().trim().min(1)).min(1).optional(),
    exclude: z.array(z.string().trim().min(1)).optional(),
    maxFileSizeBytes: z.number().int().positive().optional(),
    maxInputBytes: z.number().int().positive().optional(),
    mcpServers: z
      .array(
        z.object({
          name: z.string().trim().min(1),
          command: z.string().trim().optional(),
          args: z.array(z.string()).optional(),
          url: z.string().trim().optional(),
          trustedForMutation: z.boolean().optional(),
        })
      )
      .optional(),
    memory: memorySchema.optional(),
    experimental: z
      .object({ browserMode: z.boolean().optional() })
      .strict()
      .optional(),
    browser: browserSchema.optional(),
    worker: workerSchema.optional(),
    azure: azureSchema.optional(),
    openrouter: openrouterSchema.optional(),
    routing: routingSchema.optional(),
    serve: serveSchema.optional(),
  })
  .strict();

export const DEFAULT_PROJECT_CONFIG: Readonly<ProjectConfig> = Object.freeze({
  backend: "codex",
  provider: "codex",
  model: "gpt-5.4",
  include: Object.freeze(["src/**/*", "README.md", "package.json"]) as unknown as string[],
  exclude: Object.freeze([
    "**/*.test.ts",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**"
  ]) as unknown as string[],
  maxFileSizeBytes: 1_000_000,
  maxInputBytes: 5_000_000,
  memory: Object.freeze({
    store: "local",
    remoteBackend: "chatgpt-browser",
    remoteCacheTtlMinutes: 10,
    mirror: Object.freeze({
      minImportance: 0.7,
      types: Object.freeze(["fact", "insight"]) as unknown as MemoryMirrorConfig["types"],
    }),
  }) as unknown as MemoryConfig,
  experimental: Object.freeze({ browserMode: false }),
  browser: Object.freeze({
    model: "gpt-5.6-sol",
    manualLogin: false,
    attachRunning: false,
    modelStrategy: "select",
    followUps: Object.freeze([]) as unknown as string[],
    archive: "auto",
    attachments: "auto",
    bundleFiles: false,
    bundleFormat: "auto",
    timeout: "30m",
    inputTimeout: "2m",
    attachmentTimeout: "45s",
    maxConcurrentTabs: 3,
    hideWindow: false,
    autoReattachDelay: "30s",
    autoReattachInterval: "2m",
    autoReattachTimeout: "2m",
  }),
  worker: Object.freeze({
    pollInterval: "5s",
    heartbeat: "15s",
    staleAfter: "5m",
    retryDelay: "30s",
    maxAttempts: 3,
  }),
  azure: Object.freeze({}),
  openrouter: Object.freeze({
    baseURL: "https://openrouter.ai/api/v1",
  }),
  routing: Object.freeze({
    defaultProvider: "codex",
    preferAzure: false,
  }),
  serve: Object.freeze({
    host: "127.0.0.1",
    port: 9473,
    manualLogin: true,
  }),
});

function copyDefaults(): ProjectConfig {
  return {
    ...DEFAULT_PROJECT_CONFIG,
    include: [...DEFAULT_PROJECT_CONFIG.include],
    exclude: [...DEFAULT_PROJECT_CONFIG.exclude],
    experimental: { ...DEFAULT_PROJECT_CONFIG.experimental },
    memory: {
      ...DEFAULT_PROJECT_CONFIG.memory,
      mirror: {
        ...DEFAULT_PROJECT_CONFIG.memory.mirror,
        types: [...DEFAULT_PROJECT_CONFIG.memory.mirror.types],
      },
    },
    browser: {
      ...DEFAULT_PROJECT_CONFIG.browser,
      followUps: [...DEFAULT_PROJECT_CONFIG.browser.followUps],
    },
    worker: { ...DEFAULT_PROJECT_CONFIG.worker },
    azure: { ...DEFAULT_PROJECT_CONFIG.azure },
    openrouter: { ...DEFAULT_PROJECT_CONFIG.openrouter },
    routing: { ...DEFAULT_PROJECT_CONFIG.routing },
    serve: { ...DEFAULT_PROJECT_CONFIG.serve },
  };
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const configPath = path.join(path.resolve(root), ".oracle", "config.json");
  try {
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
    const parsed = schema.parse(raw);
    const defaults = copyDefaults();
    const backend = parsed.backend
      ?? (parsed.provider !== "auto" ? parsed.provider : undefined)
      ?? defaults.backend;
    if (!parsed.backend && parsed.provider && parsed.provider !== "auto") {
      console.warn("Warning: 'provider' in .oracle/config.json is deprecated. Please rename to 'backend'.");
    }
    return {
      ...defaults,
      ...parsed,
      backend,
      provider: parsed.provider ?? backend,
      browser: {
        ...defaults.browser,
        ...parsed.browser,
        followUps: parsed.browser?.followUps ?? defaults.browser.followUps,
      },
      memory: {
        store: parsed.memory?.store ?? defaults.memory.store,
        remoteBackend: parsed.memory?.remoteBackend ?? defaults.memory.remoteBackend,
        remoteCacheTtlMinutes:
          parsed.memory?.remoteCacheTtlMinutes ?? defaults.memory.remoteCacheTtlMinutes,
        mirror: {
          ...defaults.memory.mirror,
          ...parsed.memory?.mirror,
          types: parsed.memory?.mirror?.types ?? [...defaults.memory.mirror.types],
        },
      },
      worker: { ...defaults.worker, ...parsed.worker },
      azure: { ...defaults.azure, ...parsed.azure },
      openrouter: { ...defaults.openrouter, ...parsed.openrouter },
      routing: { ...defaults.routing, ...parsed.routing },
      serve: { ...defaults.serve, ...parsed.serve },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return copyDefaults();
    throw new OracleError(
      "ORACLE_CONFIG_INVALID",
      "The project Oracle configuration is invalid.",
      "Fix .oracle/config.json or remove it to use defaults.",
      { configPath, reason: error instanceof Error ? error.message : String(error) }
    );
  }
}
