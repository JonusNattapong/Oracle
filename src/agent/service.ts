import { defaultAgentTools } from "./tools.js";
import { runAgentLoop, type AgentRunResult, type AgentStep } from "./loop.js";
import type { AgentProvider, AgentTool } from "./types.js";
import { McpClientManager } from "../orchestrator/mcp-client-manager.js";
import { loadProjectConfig } from "../config/project.js";
import { SkillRegistry } from "../skills/registry.js";
import { FileCheckpointStore } from "./checkpoint.js";
import { loadPolicy } from "./policy.js";
import { RuntimeAgentApprovalGate } from "./approvalGate.js";
import { ProfileStore } from "../identity/profile.js";
import os from "node:os";
import path from "node:path";

const DEFAULT_AGENT_SYSTEM = [
  "You are Oracle, an autonomous coding agent operating inside the user's project.",
  "You can read/write files, search the codebase, and run shell commands.",
  "Work in small verifiable steps: inspect before you change, use focused edits.",
  "When done, stop calling tools and summarize what you changed and why.",
  "Never touch paths outside the workspace. Do not print secrets.",
].join(" ");

export interface AgentRequest {
  prompt: string;
  workspaceRoot: string;
  model: string;
  /** Analysis-only: disables write_file/edit_file. */
  readOnly?: boolean;
  /** Extra guidance prepended to the default agent system prompt. */
  systemPrefix?: string;
  /** Skill name to apply (review, debug, security, etc.). */
  skill?: string;
  maxSteps?: number;
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** Override the toolset (mainly for tests). */
  tools?: AgentTool[];
  /** Resume from a previous checkpoint id. Saves a new checkpoint each turn. */
  resumeId?: string;
  /** Override .oracle/policy.json approval mode for this run. */
  approvalMode?: "off" | "risky" | "all-mutations";
}

/**
 * AgentService drives Oracle's agentic loop: it wires the default,
 * workspace-confined filesystem toolset to a tool-capable provider and runs
 * the loop to completion.
 */
export class AgentService {
  constructor(private readonly provider: AgentProvider) {}

  async run(request: AgentRequest): Promise<AgentRunResult> {
    const readOnly = request.readOnly ?? false;
    let allTools = request.tools ?? defaultAgentTools();

    // Discover MCP tools from configured external servers
    if (!request.tools) {
      try {
        const projectConfig = await loadProjectConfig(request.workspaceRoot);
        if (projectConfig.mcpServers?.length) {
          const mgr = new McpClientManager(projectConfig.mcpServers);
          try {
            const mcpTools = await mgr.connectAll();
            if (mcpTools.length) allTools = [...allTools, ...mcpTools];
          } finally {
            await mgr.disconnectAll();
          }
        }
      } catch {
        // Non-fatal: run with local tools only if config loading fails
      }
    }

    // In read-only mode, drop mutating tools entirely so the model can't even try.
    const tools = readOnly ? allTools.filter((t) => !t.mutating) : allTools;
    const oracleDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");

    let system = request.systemPrefix
      ? `${request.systemPrefix}\n\n${DEFAULT_AGENT_SYSTEM}`
      : DEFAULT_AGENT_SYSTEM;

    // Compose skill into system prompt if specified
    if (request.skill) {
      try {
        const skillRegistry = new SkillRegistry(path.join(os.homedir(), ".oracle"));
        await skillRegistry.load();
        system = skillRegistry.compose(request.skill, system);
      } catch {
        // Non-fatal: run with base system prompt if skill loading fails
      }
    }

    const awarenessContext = await new ProfileStore(oracleDir).buildAwarenessContext({
      workspaceRoot: request.workspaceRoot,
      interface: "agent",
      backend: this.provider.id,
      readOnly
    });
    system = `${system}\n\n## Self-awareness\n${awarenessContext}`;

    const checkpointStore = new FileCheckpointStore(oracleDir);

    // Policy loading is fail-closed: an invalid policy must never silently
    // disable the workspace's security boundary.
    const loadedPolicy = await loadPolicy(request.workspaceRoot);
    const policy = request.approvalMode
      ? {
          ...loadedPolicy,
          approval: { ...loadedPolicy.approval, mode: request.approvalMode }
        }
      : loadedPolicy;
    const approvalGate = policy.approval.mode === "off"
      ? undefined
      : new RuntimeAgentApprovalGate(oracleDir, policy);

    return runAgentLoop({
      provider: this.provider,
      model: request.model,
      system,
      prompt: request.prompt,
      tools,
      context: { workspaceRoot: request.workspaceRoot, readOnly, policy },
      maxSteps: request.maxSteps,
      onStep: request.onStep,
      checkpointStore,
      resumeCheckpointId: request.resumeId,
      approvalGate
    });
  }
}

export { DEFAULT_AGENT_SYSTEM };
