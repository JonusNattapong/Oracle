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
import { registerAgentTools } from "./tools/agent.js";
import { registerConsultTool } from "./tools/consult.js";
import { registerRelayTool } from "./tools/relay.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerWebTools } from "./tools/web.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerHistoryTools } from "./tools/history.js";
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
 * Registration order is stable and grouped by category (agent, consult, relay,
 * memory, docs, web, identity, doctor, and history).
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

  // Relay tool (oracle_relay — middleman + memory bank)
  registerRelayTool(server, {
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

  // Util / diagnostics (oracle_doctor)
  registerUtilTool(server, {
    config,
    workspaceRoot,
    providerId,
    providerChecks,
    homeDir: oracleHomeDir
  });

  // History tools (oracle_history_*)
  registerHistoryTools(server);

  // Oracle profiles, sessions, skills, persona and identity setup are not
  // exposed either: each is a thing a person configures or inspects, and each
  // already has a CLI command (`oracle oracle`, `oracle session`, `oracle
  // status`, `oracle skill`, `oracle identity`). History tools stay because
  // nothing on the CLI reaches them.
  //
  // Messaging (10), task tracking (10) and GitHub (11) tools are deliberately
  // not exposed here. Every tool a client loads costs it context and one more
  // way to pick the wrong one, and these three groups are all reachable by
  // other means an agent already has: `oracle msg`/`oracle task` on the CLI,
  // and the `gh` CLI for GitHub. The default surface is 19 focused tools;
  // the implementations are untouched and still drive the CLI;
  // `oracle-msg-mcp` continues to serve messaging and tasks over MCP for
  // clients that specifically want them.
}
