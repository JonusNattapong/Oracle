import type { AgentService } from "../../agent/service.js";
import type { PipelineDeps, PipelineOutcome } from "./consultPipeline.js";
import { runConsultPipeline } from "./consultPipeline.js";
import { failure, success } from "../response.js";

export type FlowMode = "auto" | "consult" | "research" | "plan" | "act";
export type ResearchMode = "web-search" | "deep-research";
export type ActionProvider = "codex" | "anthropic" | "opencode";

export interface FlowInput {
  prompt: string;
  mode?: FlowMode;
  research?: ResearchMode;
  confirm?: boolean;
  backend?: string;
  files?: string[];
  includeDocs?: boolean;
  includeMemory?: boolean;
  conversationId?: string;
  maxSteps?: number;
}

export interface FlowDecision {
  requestedMode: FlowMode;
  mode: Exclude<FlowMode, "auto">;
  reason: string;
  requiresApproval: boolean;
  research?: ResearchMode;
}

export interface FlowDeps extends PipelineDeps {
  agent?: AgentService;
  actionProvider?: ActionProvider;
  agentUnavailableReason?: string;
}

const ACTION_WORDS = /\b(implement|fix|change|edit|write|refactor|build|create|delete|remove|upgrade|install|run|execute|deploy|publish)\b/i;
const RESEARCH_WORDS = /\b(research|investigate|compare|latest|current|recent|sources?|cite|search|look up)\b/i;

export function decideFlow(input: Pick<FlowInput, "prompt" | "mode" | "research">): FlowDecision {
  const requestedMode = input.mode ?? "auto";
  if (requestedMode === "consult") {
    return { requestedMode, mode: "consult", reason: "Explicit consultation mode.", requiresApproval: false };
  }
  if (requestedMode === "research") {
    return {
      requestedMode,
      mode: "research",
      reason: "Explicit research mode.",
      requiresApproval: false,
      research: input.research ?? "web-search",
    };
  }
  if (requestedMode === "plan") {
    return { requestedMode, mode: "plan", reason: "Explicit planning mode.", requiresApproval: true };
  }
  if (requestedMode === "act") {
    return { requestedMode, mode: "act", reason: "Explicit action mode.", requiresApproval: true };
  }

  if (ACTION_WORDS.test(input.prompt)) {
    return {
      requestedMode,
      mode: "plan",
      reason: "The request appears to require workspace changes, so Oracle prepares a plan before mutation.",
      requiresApproval: true,
    };
  }
  if (RESEARCH_WORDS.test(input.prompt)) {
    return {
      requestedMode,
      mode: "research",
      reason: "The request appears to need current or source-backed information.",
      requiresApproval: false,
      research: input.research ?? "web-search",
    };
  }
  return { requestedMode, mode: "consult", reason: "The request is a read-only consultation.", requiresApproval: false };
}

function decorate(outcome: PipelineOutcome, flow: Record<string, unknown>): PipelineOutcome {
  return {
    ...outcome,
    structuredContent: {
      ...outcome.structuredContent,
      flow,
    },
  };
}

function planPrompt(prompt: string): string {
  return [
    "Create a concise implementation plan for the task below.",
    "Do not modify files or run mutating commands.",
    "List affected paths, ordered steps, risks, and verification commands.",
    "",
    `Task: ${prompt}`,
  ].join("\n");
}

function actionPrompt(input: FlowInput): string {
  const files = input.files?.length
    ? `\nStart by inspecting these paths:\n${input.files.map((file) => `- ${file}`).join("\n")}`
    : "";
  return [
    "Execute the requested task inside the workspace.",
    "Inspect before changing, work in small verifiable steps, and run focused tests before finishing.",
    `Task: ${input.prompt}`,
    files,
  ].join("\n");
}

/**
 * Unified entry point for consultation, research, planning, and action.
 * Action is deliberately two-phase: without confirm it produces a plan;
 * with confirm it hands the task to the configured agent backend.
 */
export async function runFlow(input: FlowInput, deps: FlowDeps): Promise<PipelineOutcome> {
  const decision = decideFlow(input);
  const research = decision.research;

  if (decision.mode !== "act" || input.confirm !== true) {
    const planning = decision.mode === "plan" || decision.mode === "act";
    const outcome = await runConsultPipeline(
      {
        prompt: planning ? planPrompt(input.prompt) : input.prompt,
        preset: planning ? "flow-plan" : decision.mode,
        backend: input.backend,
        files: input.files,
        includeDocs: input.includeDocs,
        includeMemory: input.includeMemory ?? true,
        conversationId: input.conversationId,
        webSearch: decision.mode === "research" && research === "web-search",
        deepResearch: decision.mode === "research" && research === "deep-research",
      },
      deps,
    );
    return decorate(outcome, {
      requestedMode: decision.requestedMode,
      mode: decision.mode,
      status: planning ? "approval_required" : "completed",
      reason: decision.reason,
      requiresApproval: decision.requiresApproval,
      next: planning ? "Call oracle_run again with mode='act' and confirm=true to execute." : undefined,
      research,
    });
  }

  if (!deps.agent) {
    return await success(
      "The plan is ready, but no action backend is connected. Set routing.actionProvider to codex, anthropic, or opencode, then retry with confirm=true.",
      {
        flow: {
          requestedMode: decision.requestedMode,
          mode: "act",
          status: "handoff_required",
          reason: deps.agentUnavailableReason ?? "No agent-capable backend is configured.",
          actionProvider: deps.actionProvider ?? null,
          requiresApproval: true,
        },
      },
    );
  }

  try {
    const result = await deps.agent.run({
      prompt: actionPrompt(input),
      workspaceRoot: deps.workspaceRoot,
      model: deps.config.model,
      maxSteps: input.maxSteps,
    });
    const waiting = result.waitingForApproval;
    return await success(
      result.finalText,
      {
        flow: {
          requestedMode: decision.requestedMode,
          mode: "act",
          status: waiting ? "waiting_for_approval" : result.stoppedOnLimit ? "step_limit" : "completed",
          reason: decision.reason,
          requiresApproval: Boolean(waiting),
          actionProvider: deps.actionProvider ?? null,
          checkpointId: result.checkpointId ?? null,
          approval: waiting ?? null,
          steps: result.steps.length,
          changes: result.audit.getSummary(),
          usage: result.usage,
        },
      },
    );
  } catch (error) {
    return failure(error);
  }
}
