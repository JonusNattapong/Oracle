import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/server";
import { loadProjectConfig } from "../config/project.js";
import { ConsultService } from "../core/consult.js";
import {
  createExecutionBackend,
  createAgentBackend,
  parseBackendName
} from "../providers/factory.js";
import { resolveProviderRoute } from "../providers/router.js";
import { AgentService } from "../agent/service.js";
import { SkillRegistry } from "../skills/registry.js";
import { OracleRegistry } from "../oracles/registry.js";
import { ProfileStore } from "../identity/profile.js";
import { OrchestratorFactory } from "../orchestrator/factory.js";
import { MemoryAdapter } from "../memory/adapter.js";
import { VERSION } from "../version.js";
import { registerOracleTools } from "./server.js";

export async function createOracleMcpServer(
  workspace = process.env.ORACLE_WORKSPACE_ROOT ?? process.cwd()
): Promise<McpServer> {
  const workspaceRoot = path.resolve(workspace);
  const config = await loadProjectConfig(workspaceRoot);
  const requestedModel =
    config.provider === "browser" ? config.browser.model : config.model;
  const route = resolveProviderRoute({
    model: requestedModel,
    selection: config.provider,
    selectionSource: "project-config",
    config,
  });
  const resolvedConfig = {
    ...config,
    backend: route.provider,
    provider: route.provider,
    model: route.model,
  };
  const homeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
  const skills = new SkillRegistry(homeDir, path.join(workspaceRoot, ".oracle", "skills"));
  await skills.load();
  const oracles = new OracleRegistry(homeDir, workspaceRoot);
  const instructions = [
    // ── Memory (auto-remembered project knowledge) ──
    "Oracle has persistent memory scoped to this project. Use oracle_memory_search to find relevant facts before answering; use oracle_memory_remember to save decisions, conventions, and gotchas. Memory auto-ranks by recency and importance.",
    "",
    // ── Knowledge base (docs) ──
    ".oracle/docs/ is a project-level knowledge base. Use oracle_docs_search to find documentation snippets. Use oracle_docs_add to add new docs.",
    "",
    // ── Consult (ask with context) ──
    "oracle_ask is a single entry point for Q&A — pass files, context, or a conversationId for multi-turn recall. The answer will include project memory and docs context automatically. With the chatgpt-browser backend, set web_search or deep_research for a web-grounded turn.",
    "",
    // ── Relay (middleman + memory bank) ──
    "oracle_relay is the middleman/middleware entry point: it archives your request, enriches it with recalled memory, consults the AI backend, then files the Q&A into the memory bank (tagged `relay`) so the same question is answered from memory on future calls.",
    "",
    // ── Agent (autonomous coding loop) ──
    "oracle_agent runs an autonomous coding loop inside the workspace: reads/writes/edits files and runs shell commands. Use for implementation tasks, refactoring, and bug fixing. Confined to the workspace with audit trail.",
    "",
    // ── Web search ──
    "oracle_web_search and oracle_web_fetch let you search and read web pages when the task needs external API docs, troubleshooting, or live data.",
    "",
    // ── Identity ──
    "Use oracle_identity_show or oracle_awareness_show to inspect Oracle's identity, environment, capabilities, and boundaries. Configure the operator profile with the CLI (`oracle identity`). Awareness is auto-injected into consults and agent runs.",
    "",
    // ── Init ──
    "Bootstrap a new workspace with the CLI (`oracle init`); the MCP surface starts after the workspace is initialized.",
    "",
  ].join("\n");

  const server = new McpServer(
    { name: "oracle", version: VERSION },
    { instructions }
  );

  // Use OrchestratorFactory to create adapters with MCP support
  const orchestrator = new OrchestratorFactory(workspaceRoot, homeDir);
  const memory = await orchestrator.createMemoryAdapter();
  const globalMemory = new MemoryAdapter(homeDir, "memory");

  // Start periodic background maintenance.
  // Default: consolidate + prune+promote every 1h,
  //          graph prune every 2h,
  //          LLM reflection every 4h (if ANTHROPIC_API_KEY is set).
  memory.startAutoMaintenance?.();
  if (process.env.ORACLE_DEBUG) {
    console.error("[oracle-mcp] background memory maintenance started (1h interval, graph prune 2h, reflection 4h)");
  }

  const configuredProfile = config.browser.profileDir;
  const backendOptions = {
    homeDir,
    experimentalBrowserMode: config.experimental?.browserMode,
    experimentalBrowserStream: config.experimental?.browserStream,
    browser: {
      ...config.browser,
      browserTimeout: config.browser.timeout,
      browserInputTimeout: config.browser.inputTimeout,
      maxConcurrentTabs: String(config.browser.maxConcurrentTabs),
      profileDir: configuredProfile
        ? path.resolve(homeDir, configuredProfile)
        : path.join(homeDir, "chrome-profile"),
      remoteHost: process.env.ORACLE_REMOTE_HOST ?? config.browser.remoteHost,
      remoteToken: process.env.ORACLE_REMOTE_TOKEN
    },
    azure: config.azure,
    openrouter: config.openrouter
  };

  let agent: AgentService | undefined;
  let agentUnavailableReason: string | undefined;
  try {
    agent = new AgentService(createAgentBackend(route.provider));
  } catch (error) {
    agentUnavailableReason = error instanceof Error ? error.message : String(error);
  }

  registerOracleTools({
    server,
    service: new ConsultService(
      createExecutionBackend(route.provider, backendOptions),
      undefined,
      undefined,
      undefined,
      (requested) => createExecutionBackend(parseBackendName(requested), backendOptions)
    ),
    config: resolvedConfig,
    workspaceRoot,
    providerId: route.provider,
    skills,
    oracles,
    memory,
    globalMemory,
    profile: new ProfileStore(homeDir),
    agent,
    agentUnavailableReason
  });
  return server;
}
