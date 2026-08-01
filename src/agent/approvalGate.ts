import type {
  ApprovalExecution,
  ApprovalRequest,
  ApprovalRisk
} from "../control/types.js";
import { approvalPayloadHash } from "../control/payload.js";
import { RuntimeClient } from "../runtime/client.js";
import type { OraclePolicy } from "./policy.js";
import type { AgentTool, ToolCall } from "./types.js";

export interface ToolRiskAssessment {
  risk: ApprovalRisk;
  reason: string;
}

export interface ApprovalGateRequest {
  call: ToolCall;
  tool: AgentTool;
  checkpointId: string;
  workspaceRoot: string;
  requestedBy: string;
  assessment: ToolRiskAssessment;
}

export interface ApprovalGateClaim {
  approval: ApprovalRequest;
  execution: ApprovalExecution;
}

export interface AgentApprovalGate {
  assess(tool: AgentTool, input: Record<string, unknown>): ToolRiskAssessment | null;
  request(input: ApprovalGateRequest): Promise<ApprovalRequest>;
  get(id: string): Promise<ApprovalRequest | null>;
  claim(approval: ApprovalRequest, claimedBy: string): Promise<ApprovalGateClaim>;
  complete(
    executionId: string,
    status: "completed" | "failed",
    result?: Record<string, unknown>
  ): Promise<void>;
}

export class ApprovalRuntimeUnavailableError extends Error {
  constructor() {
    super("A risky action needs agent approval, but Oracle Runtime is not running. Start it with `oracle daemon start`, then resume this checkpoint.");
    this.name = "ApprovalRuntimeUnavailableError";
  }
}

export class RuntimeAgentApprovalGate implements AgentApprovalGate {
  private readonly reviewers: string[];
  private readonly mode: OraclePolicy["approval"]["mode"];

  constructor(
    private readonly homeDir: string,
    private readonly policy: OraclePolicy
  ) {
    const configured = policy.approval.reviewers
      ?? process.env.ORACLE_APPROVAL_REVIEWERS?.split(",")
      ?? ["claude-reviewer", "codex-reviewer"];
    this.reviewers = [...new Set(configured.map((value) => value.trim()).filter(Boolean))];
    this.mode = policy.approval.mode;
  }

  assess(tool: AgentTool, input: Record<string, unknown>): ToolRiskAssessment | null {
    if (this.mode === "off" || !tool.mutating) return null;
    const assessment = classifyToolRisk(tool.name, input);
    if (this.mode === "all-mutations") {
      return assessment ?? {
        risk: "medium",
        reason: `${tool.name} mutates the workspace`
      };
    }
    return assessment?.risk === "high" ? assessment : null;
  }

  async request(input: ApprovalGateRequest): Promise<ApprovalRequest> {
    const client = await this.client();
    const action = {
      type: "agent.tool",
      payload: {
        toolName: input.call.name,
        input: input.call.input,
        workspaceRoot: input.workspaceRoot
      }
    };
    const desiredQuorum = input.assessment.risk === "high"
      ? this.policy.approval.highRiskQuorum ?? Math.min(2, this.reviewers.length)
      : 1;
    if (desiredQuorum > this.reviewers.length) {
      throw new Error(
        `Approval policy requires ${desiredQuorum} reviewers, but only ${this.reviewers.length} are configured. Set approval.reviewers in .oracle/policy.json.`
      );
    }
    return client.createApproval({
      kind: input.call.name === "bash" ? "command" : "policy",
      title: `Agent requests ${input.call.name}`,
      description: describeToolCall(input.call, input.assessment.reason),
      requestedBy: input.requestedBy,
      assignedTo: this.reviewers[0],
      authorizedReviewers: this.reviewers,
      requiredApprovals: desiredQuorum,
      risk: input.assessment.risk,
      expiresInMinutes: this.policy.approval.expiryMinutes,
      action,
      checkpointId: input.checkpointId,
      localOnly: input.assessment.risk === "high"
        && !this.policy.approval.allowTelegramHighRisk,
      metadata: {
        reason: input.assessment.reason,
        toolCallId: input.call.id
      }
    });
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    return (await this.client()).getApproval(id);
  }

  async claim(approval: ApprovalRequest, claimedBy: string): Promise<ApprovalGateClaim> {
    if (!approval.action || !approval.payloadHash) {
      throw new Error(`Approval ${approval.id} has no executable action.`);
    }
    const calculated = approvalPayloadHash(approval.action);
    if (calculated !== approval.payloadHash) {
      throw new Error(`Approval ${approval.id} payload integrity check failed.`);
    }
    const execution = await (await this.client()).claimApprovalExecution(approval.id, {
      payloadHash: calculated,
      claimedBy
    });
    return { approval, execution };
  }

  async complete(
    executionId: string,
    status: "completed" | "failed",
    result?: Record<string, unknown>
  ): Promise<void> {
    await (await this.client()).completeApprovalExecution(executionId, { status, result });
  }

  private async client(): Promise<RuntimeClient> {
    const client = await RuntimeClient.connect(this.homeDir);
    if (!client) throw new ApprovalRuntimeUnavailableError();
    return client;
  }
}

export function classifyToolRisk(
  toolName: string,
  input: Record<string, unknown>
): ToolRiskAssessment | null {
  if (
    toolName !== "bash"
    && /(?:^|[_-])(deploy|publish|push|delete|destroy|release|merge|send)(?:$|[_-])/i.test(toolName)
  ) {
    return {
      risk: "high",
      reason: `${toolName} is a trusted external mutation with irreversible or remote effects`
    };
  }
  if (toolName !== "bash") return null;
  const command = typeof input.command === "string"
    ? input.command.trim().replace(/\s+/g, " ")
    : "";
  const patterns: Array<[RegExp, string]> = [
    [/\bgit\s+push\b/i, "publishes commits to a remote repository"],
    [/\b(?:npm|pnpm|yarn)\s+publish\b/i, "publishes a package"],
    [/\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall)\b/i, "changes installed dependencies"],
    [/\b(?:kubectl|helm)\s+(?:apply|delete|upgrade|install|rollback)\b/i, "changes a cluster"],
    [/\bterraform\s+(?:apply|destroy|import)\b/i, "changes infrastructure"],
    [/\bdocker\s+push\b/i, "publishes a container image"],
    [/\b(?:gh|glab)\s+pr\s+(?:merge|close)\b/i, "changes a pull request"],
    [/\b(?:ssh|scp|rsync|ngrok|cloudflared)\b/i, "connects to an external machine or tunnel"],
    [/\b(?:sudo|systemctl|service|launchctl)\b/i, "changes host services or privileges"],
    [/\b(?:rm|rmdir|mv|chmod|chown|kill|pkill)\b/i, "can delete, move, or alter host resources"],
    [/\bcurl\b[^|;&]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i, "sends a mutating network request"]
  ];
  const match = patterns.find(([pattern]) => pattern.test(command));
  return match ? { risk: "high", reason: match[1] } : null;
}

function describeToolCall(call: ToolCall, reason: string): string {
  if (call.name === "bash" && typeof call.input.command === "string") {
    return `${reason}. Command: ${call.input.command.slice(0, 500)}`;
  }
  const target = typeof call.input.path === "string" ? ` ${call.input.path}` : "";
  return `${reason}.${target}`.trim();
}
