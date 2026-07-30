import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectConfig } from "../config/project.js";
import type { ConsultService } from "../core/consult.js";
import { checkBackend } from "../providers/factory.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { OracleRegistry } from "../oracles/registry.js";
import { ProfileStore } from "../identity/profile.js";
import type { MemoryPort } from "../orchestrator/ports.js";
import type { AgentService } from "../agent/service.js";
import type { MessageStore } from "../messaging/store.js";
import type { AgentRegistry } from "../messaging/registry.js";
import type { TaskStore } from "../tasks/store.js";
import type { CoordinationService } from "../coordination/service.js";
import { registerMessagingTools } from "./messagingTools.js";
import { registerTaskTools } from "./taskTools.js";
import { registerAgentTools } from "./tools/agent.js";
import { registerConsultTool } from "./tools/consult.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerWebTools } from "./tools/web.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerOracleProfileTools } from "./tools/oracle.js";
import { registerSessionTools } from "./tools/session.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerGitHubTools } from "./tools/github.js";
import { registerUtilTool } from "./tools/util.js";

interface OracleServerDependencies {
  server: McpServer;
  service: ConsultService;
  config: ProjectConfig;
  workspaceRoot: string;
  providerId: string;
  skills: SkillRegistry;
  oracles: OracleRegistry;
  memory: MemoryPort;
  globalMemory?: MemoryPort;
  profile: ProfileStore;
  messages: MessageStore;
  agentRegistry: AgentRegistry;
  tasks: TaskStore;
  coordination?: CoordinationService;
  providerChecks?: typeof checkBackend;
  agent?: AgentService;
  agentUnavailableReason?: string;
}

const oracleHomeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
const SOULS_DIR = path.join(oracleHomeDir, "souls");

/**
 * Register every Oracle tool on the MCP server. Delegates to category-specific
 * registration functions in src/mcp/tools/ so the surface stays organised.
 *
 * Registration order is stable and grouped by category (agent, consult, memory,
 * docs, web, identity, oracle profiles, sessions, doctor, messaging, tasks,
 * history, GitHub).
 */
export function registerOracleTools(deps: OracleServerDependencies): void {
  const {
    server,
    service,
    config,
    workspaceRoot,
    providerId,
    skills,
    oracles,
    memory,
    globalMemory = memory,
    profile,
    messages,
    agentRegistry,
    tasks,
    coordination,
    providerChecks = checkBackend,
    agent,
    agentUnavailableReason,
  } = deps;

  // Agent tools (oracle_agent + checkpoints)
  registerAgentTools(server, { config, workspaceRoot, skills, agent, agentUnavailableReason });

  // Consult tool (oracle_ask)
  registerConsultTool(server, {
    service,
    config,
    workspaceRoot,
    providerId,
    memory,
    soulsDir: SOULS_DIR,
    profile
  });

  // Memory tools (oracle_memory_*)
  registerMemoryTools(server, { memory, globalMemory, workspaceRoot });

  // Docs tools (oracle_docs_*)
  registerDocsTools(server, workspaceRoot);

  // Web tools (oracle_web_*)
  registerWebTools(server);

  // Identity tools (oracle_identity_*)
  registerIdentityTools(server, profile, {
    workspaceRoot,
    interface: "mcp",
    backend: providerId
  });

  // Oracle profile tools (oracle_oracle_*)
  registerOracleProfileTools(server, oracles);

  // Session tools (oracle_sessions, oracle_session_get)
  registerSessionTools(server, service);

  // Util / diagnostics (oracle_doctor)
  registerUtilTool(server, {
    config,
    workspaceRoot,
    providerId,
    providerChecks,
    homeDir: oracleHomeDir
  });

  // ── Inter-agent messaging & tasks ─────────────────────────────────
  // (already separated — these register in their own category files)
  registerMessagingTools(server, messages, agentRegistry);
  registerTaskTools(server, tasks, messages, agentRegistry, coordination);

  // History tools (oracle_history_*)
  registerHistoryTools(server);

  // GitHub tools (oracle_github_*)
  registerGitHubTools(server, { workspaceRoot, service, providerId, config });
}
