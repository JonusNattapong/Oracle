import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadProjectConfig } from "../config/project.js";
import { ConsultService } from "../core/consult.js";
import { createProvider, createAgentProvider } from "../providers/factory.js";
import { AgentService } from "../agent/service.js";
import { SkillRegistry } from "../skills/registry.js";
import { OracleRegistry } from "../oracles/registry.js";
import { ProfileStore } from "../identity/profile.js";
import { MessageStore } from "../messaging/store.js";
import { AgentRegistry } from "../messaging/registry.js";
import { TaskStore } from "../tasks/store.js";
import { SwarmStore } from "../orchestrator/swarmStore.js";
import { CoordinationService } from "../coordination/service.js";
import { MESSAGING_INSTRUCTIONS } from "./messagingTools.js";
import { TASK_INSTRUCTIONS } from "./taskTools.js";
import { OrchestratorFactory } from "../orchestrator/factory.js";
import { MemoryAdapter } from "../memory/adapter.js";
import { VERSION } from "../version.js";
import { registerOracleTools } from "./server.js";

export async function createOracleMcpServer(
  workspace = process.env.ORACLE_WORKSPACE_ROOT ?? process.cwd()
): Promise<McpServer> {
  const workspaceRoot = path.resolve(workspace);
  const config = await loadProjectConfig(workspaceRoot);
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
    "oracle_ask is a single entry point for Q&A — pass files, context, or a conversationId for multi-turn recall. The answer will include project memory and docs context automatically.",
    "",
    // ── Agent (autonomous coding loop) ──
    "oracle_agent runs an autonomous coding loop inside the workspace: reads/writes/edits files and runs shell commands. Use for implementation tasks, refactoring, and bug fixing. Confined to the workspace with audit trail.",
    "",
    // ── Web search ──
    "oracle_web_search and oracle_web_fetch let you search and read web pages when the task needs external API docs, troubleshooting, or live data.",
    "",
    // ── Identity ──
    "Use oracle_identity_setup to configure your profile; oracle_identity_show to view it. The identity is auto-injected into consults.",
    "",
    // ── Init ──
    "oracle_init bootstraps .oracle/ in a new project with policy.json (zero-trust rules), config.json, docs/, and skills/.",
    "",
    // ── Messaging & tasks (from below) ──
    MESSAGING_INSTRUCTIONS,
    TASK_INSTRUCTIONS,
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

  let agent: AgentService | undefined;
  let agentUnavailableReason: string | undefined;
  try {
    agent = new AgentService(createAgentProvider(config.provider));
  } catch (error) {
    agentUnavailableReason = error instanceof Error ? error.message : String(error);
  }

  const messages = new MessageStore(homeDir);
  const tasks = new TaskStore(homeDir);
  const coordination = new CoordinationService(tasks, messages, new SwarmStore(homeDir));

  registerOracleTools({
    server,
    service: new ConsultService(createProvider(config.provider)),
    config,
    workspaceRoot,
    providerId: config.provider,
    skills,
    oracles,
    memory,
    globalMemory,
    profile: new ProfileStore(homeDir),
    messages,
    agentRegistry: new AgentRegistry(homeDir),
    tasks,
    coordination,
    agent,
    agentUnavailableReason
  });
  return server;
}
