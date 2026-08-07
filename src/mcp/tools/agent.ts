import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentService } from "../../agent/service.js";
import { FileCheckpointStore } from "../../agent/checkpoint.js";
import type { SkillRegistry } from "../../skills/registry.js";
import path from "node:path";
import os from "node:os";
import type { ProjectConfig } from "../../config/project.js";
import { OracleError } from "../../errors.js";
import { success, failure } from "../response.js";

export function registerAgentTools(
  server: McpServer,
  deps: {
    config: ProjectConfig;
    workspaceRoot: string;
    skills: SkillRegistry;
    agent?: AgentService;
    agentUnavailableReason?: string;
  }
): void {
  server.registerTool(
    "oracle_agent",
    {
      title: "Run Oracle Agent",
      description: "Autonomous coding loop — reads/writes files and runs shell commands.",
      inputSchema: {
        prompt: z.string().min(1).max(50000),
        readOnly: z.boolean().optional(),
        skill: z.string().optional().describe("Skill to apply (review, debug, security, architecture, tests)"),
        maxSteps: z.number().int().min(1).max(50).optional(),
        resumeId: z.string().optional().describe("Checkpoint id to resume from a previous interrupted run. Returns checkpointId on each run for this purpose.")
      }
    },
    async ({ prompt, readOnly, skill, maxSteps, resumeId }) => {
      try {
        if (!deps.agent) {
          throw new OracleError(
            "ORACLE_AGENT_UNAVAILABLE",
            "The agent is not available with the configured provider.",
            deps.agentUnavailableReason ?? "Set provider to 'anthropic' or 'opencode' in .oracle/config.json."
          );
        }
        const result = await deps.agent.run({ prompt, workspaceRoot: deps.workspaceRoot, model: deps.config.model, readOnly, skill, maxSteps, resumeId });
        return success(result.finalText, {
          finalText: result.finalText,
          steps: result.steps,
          stoppedOnLimit: result.stoppedOnLimit,
          turns: result.steps.length,
          usage: result.usage,
          readOnly: readOnly ?? false,
          skill: skill ?? undefined,
          checkpointId: result.checkpointId ?? null
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  // ── Checkpoint management tools ──────────────────────────────────

  const oracleDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
  const checkpointStore = new FileCheckpointStore(oracleDir);

  server.registerTool(
    "oracle_agent_checkpoints",
    {
      title: "List Agent Checkpoints",
      description:
        "List saved agent loop checkpoints. Pass a checkpoint id to oracle_agent as resumeId to continue an interrupted run.",
      inputSchema: {}
    },
    async () => {
      try {
        const list = await checkpointStore.list();
        const lines = list.length
          ? list.map((c: { id: string; updatedAt: string }) => `${c.id} (${c.updatedAt})`).join("\n")
          : "No checkpoints found.";
        return success(lines, { count: list.length, checkpoints: list });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_agent_checkpoint_delete",
    {
      title: "Delete Agent Checkpoint",
      description: "Delete a saved checkpoint by id.",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      try {
        await checkpointStore.delete(id);
        return success(`Deleted checkpoint ${id}.`, { removed: true });
      } catch (error) { return failure(error); }
    }
  );

}
