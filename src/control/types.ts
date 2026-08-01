import type { AuditRecord } from "../observability/audit.js";
import type { AuditVerification } from "../observability/audit.js";
import type { MemoryStoreEntry } from "../memory/adapter.js";
import type { AgentRecord } from "../messaging/registry.js";
import type { CronTask } from "../scheduler/taskStore.js";
import type { TaskRecord, TaskStatus } from "../tasks/store.js";

export type ApprovalKind = "task_review" | "command" | "policy" | "custom";
export type ApprovalRisk = "low" | "medium" | "high";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired";
/** Decisions are produced by registered automation agents through the local API. */
export type ApprovalDecisionChannel = "agent" | "api" | "recovery";

export interface ApprovalAction {
  type: string;
  payload: Record<string, unknown>;
}

export interface ApprovalVote {
  actor: string;
  decision: "approve" | "reject";
  channel: ApprovalDecisionChannel;
  note?: string;
  createdAt: string;
}

export type ApprovalExecutionStatus = "claimed" | "completed" | "failed";

export interface ApprovalExecution {
  id: string;
  approvalId: string;
  payloadHash: string;
  status: ApprovalExecutionStatus;
  claimedBy: string;
  claimedAt: string;
  completedAt?: string;
  result?: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  sourceKey?: string;
  kind: ApprovalKind;
  title: string;
  description?: string;
  requestedBy: string;
  assignedTo: string;
  authorizedReviewers: string[];
  risk: ApprovalRisk;
  status: ApprovalStatus;
  version: number;
  requiredApprovals: number;
  approvalCount: number;
  taskId?: string;
  messageId?: string;
  workflowId?: string;
  expiresAt?: string;
  payloadHash?: string;
  action?: ApprovalAction;
  checkpointId?: string;
  localOnly: boolean;
  votes: ApprovalVote[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  notifiedAt?: string;
}

export interface CreateApprovalInput {
  kind?: ApprovalKind;
  title: string;
  description?: string;
  requestedBy: string;
  assignedTo: string;
  authorizedReviewers?: string[];
  requiredApprovals?: number;
  risk?: ApprovalRisk;
  taskId?: string;
  messageId?: string;
  workflowId?: string;
  expiresAt?: string;
  expiresInMinutes?: number;
  action?: ApprovalAction;
  checkpointId?: string;
  localOnly?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
  decidedBy: string;
  expectedVersion: number;
  channel?: ApprovalDecisionChannel;
  note?: string;
}

export interface ClaimApprovalExecutionInput {
  payloadHash: string;
  claimedBy: string;
}

export interface CompleteApprovalExecutionInput {
  executionId: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
}

export interface TaskVisualization {
  total: number;
  active: number;
  byStatus: Record<TaskStatus, number>;
  recent: TaskRecord[];
}

export interface MemoryVisualization {
  total: number;
  byType: Record<string, number>;
  byAgent: Record<string, number>;
  recent: MemoryStoreEntry[];
}

export interface AuditVisualization {
  total: number;
  policyDenials: number;
  byAction: Record<string, number>;
  recent: AuditRecord[];
  integrity: AuditVerification;
}

export interface ControlCenterSnapshot {
  generatedAt: string;
  version: string;
  workspaceRoot: string;
  runtime: {
    pid: number;
    uptimeSeconds: number;
    schedulerRunning: boolean;
    scheduledTasks: number;
  };
  agents: {
    total: number;
    active: number;
    items: Array<AgentRecord & { active: boolean }>;
  };
  schedules: CronTask[];
  approvals: {
    pending: number;
    byRisk: Record<ApprovalRisk, number>;
    items: ApprovalRequest[];
  };
  tasks: TaskVisualization;
  memory: {
    project: MemoryVisualization;
    global: MemoryVisualization;
  };
  audit: AuditVisualization;
}
