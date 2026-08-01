import { CoordinationService } from "../coordination/service.js";
import { MemoryAdapter, type MemoryStoreEntry } from "../memory/adapter.js";
import type { MaintenanceResult } from "../memory/maintenance.js";
import { MessageStore } from "../messaging/store.js";
import { AgentRegistry } from "../messaging/registry.js";
import { AuditLogger, type AuditRecord } from "../observability/audit.js";
import { SwarmStore } from "../orchestrator/swarmStore.js";
import type { RuntimeDatabase } from "../runtime/database.js";
import type { RuntimeEventBus } from "../runtime/events.js";
import type { SchedulerService } from "../runtime/schedulerService.js";
import { TaskStore, type TaskRecord, type TaskStatus } from "../tasks/store.js";
import { VERSION } from "../version.js";
import { ApprovalStore } from "./approvalStore.js";
import type {
  ApprovalExecution,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRisk,
  AuditVisualization,
  ClaimApprovalExecutionInput,
  CompleteApprovalExecutionInput,
  ControlCenterSnapshot,
  CreateApprovalInput,
  MemoryVisualization,
  TaskVisualization
} from "./types.js";

const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "in_progress",
  "review",
  "done",
  "blocked",
  "cancelled"
];

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "pending",
  "in_progress",
  "review",
  "blocked"
]);

export class ControlCenterService {
  readonly approvals: ApprovalStore;
  private readonly tasks: TaskStore;
  private readonly messages: MessageStore;
  private readonly swarms: SwarmStore;
  private readonly coordination: CoordinationService;
  private readonly agents: AgentRegistry;
  private readonly projectMemory: MemoryAdapter;
  private readonly globalMemory: MemoryAdapter;
  private readonly audit = new AuditLogger();
  private expiryTimer?: NodeJS.Timeout;

  constructor(
    database: RuntimeDatabase,
    private readonly events: RuntimeEventBus,
    private readonly scheduler: SchedulerService,
    private readonly options: {
      homeDir: string;
      workspaceRoot: string;
    }
  ) {
    this.approvals = new ApprovalStore(database);
    this.tasks = new TaskStore(options.homeDir);
    this.messages = new MessageStore(options.homeDir);
    this.swarms = new SwarmStore(options.homeDir);
    this.coordination = new CoordinationService(
      this.tasks,
      this.messages,
      this.swarms
    );
    this.agents = new AgentRegistry(options.homeDir);
    this.projectMemory = new MemoryAdapter(options.workspaceRoot);
    this.globalMemory = new MemoryAdapter(options.homeDir, "memory");
  }

  start(): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => {
      void this.expireApprovals();
    }, 30_000);
    this.expiryTimer.unref();
  }

  stop(): void {
    if (!this.expiryTimer) return;
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  dispose(): void {
    this.tasks.dispose();
    this.messages.dispose();
    this.swarms.dispose();
    this.agents.dispose();
  }

  async snapshot(): Promise<ControlCenterSnapshot> {
    await this.expireApprovals();
    await this.syncTaskApprovals();
    const [
      tasks,
      projectStats,
      projectRecent,
      globalStats,
      globalRecent,
      audits,
      auditIntegrity,
      schedules,
      agents
    ] =
      await Promise.all([
        this.tasks.list(),
        this.projectMemory.getStats(),
        this.projectMemory.recall({ limit: 12, touch: false }),
        this.globalMemory.getStats(),
        this.globalMemory.recall({ limit: 12, touch: false }),
        this.audit.readRecords(this.options.workspaceRoot, 200),
        this.audit.verify(this.options.workspaceRoot),
        this.scheduler.list(),
        this.agents.list()
      ]);
    const pending = this.approvals.list({ status: "pending", limit: 100 });
    return {
      generatedAt: new Date().toISOString(),
      version: VERSION,
      workspaceRoot: this.options.workspaceRoot,
      runtime: {
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        schedulerRunning: this.scheduler.isRunning,
        scheduledTasks: schedules.length
      },
      agents: {
        total: agents.length,
        active: agents.filter((agent) => agent.active).length,
        items: agents
      },
      schedules,
      approvals: {
        pending: pending.length,
        byRisk: this.countApprovalRisk(pending),
        items: pending
      },
      tasks: this.taskVisualization(tasks),
      memory: {
        project: this.memoryVisualization(projectStats, projectRecent),
        global: this.memoryVisualization(globalStats, globalRecent)
      },
      audit: this.auditVisualization(audits, auditIntegrity)
    };
  }

  async listApprovals(
    status?: "pending" | "approved" | "rejected" | "cancelled" | "expired"
  ): Promise<ApprovalRequest[]> {
    await this.expireApprovals();
    await this.syncTaskApprovals();
    return this.approvals.list({ status, limit: 200 });
  }

  getApproval(id: string): ApprovalRequest | null {
    void this.expireApprovals();
    return this.approvals.get(id);
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRequest> {
    if (input.kind === "task_review") {
      throw new Error("task_review approvals are created automatically when a task enters review.");
    }
    const approval = this.approvals.create(input);
    this.events.publish("approval.requested", {
      approvalId: approval.id,
      kind: approval.kind,
      risk: approval.risk,
      assignedTo: approval.assignedTo,
      taskId: approval.taskId
    });
    await this.logDecision("requested", approval, input.requestedBy);
    return approval;
  }

  async decide(id: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    await this.expireApprovals();
    const approval = this.approvals.assertDecidable(id, decision);
    const finalApprovalVote = decision.decision === "approve"
      && approval.approvalCount + 1 >= approval.requiredApprovals;

    if (finalApprovalVote && approval.kind === "task_review" && approval.taskId) {
      const task = await this.tasks.get(approval.taskId);
      if (!task) throw new Error(`Linked task not found: ${approval.taskId}`);
      if (task.status !== "review") {
        const reconciled = this.reconcileFromTask(approval, task);
        if (reconciled) return reconciled;
        throw new Error(`Linked task ${task.id} is ${task.status}, not review.`);
      }
      await this.coordination.closeTask(
        task.id,
        decision.decidedBy,
        decision.decision === "approve",
        decision.note
      );
    }

    const updated = this.approvals.decide(id, decision);
    const eventType = updated.status === "pending"
      ? "approval.vote.recorded"
      : updated.status === "approved"
        ? "approval.approved"
        : "approval.rejected";
    this.events.publish(eventType, {
        approvalId: updated.id,
        decidedBy: decision.decidedBy,
        taskId: updated.taskId,
        note: decision.note,
        channel: decision.channel ?? "api",
        version: updated.version,
        approvalCount: updated.approvalCount,
        requiredApprovals: updated.requiredApprovals
    });
    await this.logDecision(
      updated.status === "pending" ? "vote" : decision.decision,
      updated,
      decision.decidedBy,
      decision.note
    );
    return updated;
  }

  async submitTaskForReview(
    taskId: string,
    actor: string,
    summary?: string
  ): Promise<TaskRecord> {
    const task = await this.coordination.submitTask(
      taskId,
      actor,
      summary ?? "Submitted for review from Control Center."
    );
    this.events.publish("swarm.task.submitted", {
      taskId: task.id,
      actor,
      status: task.status
    });
    return task;
  }

  async closeTask(taskId: string, actor: string, note?: string): Promise<TaskRecord> {
    const task = await this.coordination.closeTask(taskId, actor, true, note);
    this.events.publish("swarm.task.closed", {
      taskId: task.id,
      actor,
      approved: true
    });
    return task;
  }

  async runMemoryMaintenance(): Promise<{
    project: MaintenanceResult;
    global: MaintenanceResult;
  }> {
    const [project, globalMemory] = await Promise.all([
      this.projectMemory.runMaintenance(),
      this.globalMemory.runMaintenance()
    ]);
    this.events.publish("memory.maintenance.completed", {
      projectPruned: project.pruned.length,
      projectPromoted: project.promoted.length,
      globalPruned: globalMemory.pruned.length,
      globalPromoted: globalMemory.promoted.length
    });
    return { project, global: globalMemory };
  }

  async claimExecution(
    id: string,
    input: ClaimApprovalExecutionInput
  ): Promise<ApprovalExecution> {
    const execution = this.approvals.claimExecution(id, input.payloadHash, input.claimedBy);
    this.events.publish("approval.execution.claimed", {
      approvalId: id,
      executionId: execution.id,
      claimedBy: execution.claimedBy,
      payloadHash: execution.payloadHash
    });
    await this.audit.log(this.options.workspaceRoot, {
      action: "tool",
      target: `approval-execution:${execution.id}`,
      agentId: execution.claimedBy,
      details: {
        controlCenterAction: "execution_claimed",
        approvalId: id,
        payloadHash: execution.payloadHash
      }
    });
    return execution;
  }

  async completeExecution(
    input: CompleteApprovalExecutionInput
  ): Promise<ApprovalExecution> {
    const execution = this.approvals.completeExecution(input);
    this.events.publish(`approval.execution.${input.status}`, {
      approvalId: execution.approvalId,
      executionId: execution.id,
      claimedBy: execution.claimedBy
    });
    await this.audit.log(this.options.workspaceRoot, {
      action: "tool",
      target: `approval-execution:${execution.id}`,
      agentId: execution.claimedBy,
      details: {
        controlCenterAction: `execution_${input.status}`,
        approvalId: execution.approvalId,
        result: input.result
      }
    });
    return execution;
  }

  private async expireApprovals(): Promise<void> {
    for (const approval of this.approvals.expireDue()) {
      this.events.publish("approval.expired", {
        approvalId: approval.id,
        checkpointId: approval.checkpointId,
        version: approval.version
      });
      await this.logDecision("expired", approval, "runtime-expiry");
    }
  }

  async syncTaskApprovals(): Promise<void> {
    const tasks = await this.tasks.list();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks.filter((candidate) => candidate.status === "review")) {
      const reviewKey = [...task.notes]
        .reverse()
        .find((note) => note.text.startsWith("Submitted for review:"))?.ts
        ?? task.updatedAt;
      const ensured = this.approvals.ensureTaskReview({
        taskId: task.id,
        reviewKey,
        title: `Review: ${task.title}`,
        description: task.notes.at(-1)?.text ?? task.description,
        requestedBy: task.assignee,
        assignedTo: task.createdBy,
        messageId: task.messageIds.at(-1),
        workflowId: task.workflowId
      });
      if (ensured.created) {
        this.events.publish("approval.requested", {
          approvalId: ensured.approval.id,
          kind: "task_review",
          risk: ensured.approval.risk,
          assignedTo: ensured.approval.assignedTo,
          taskId: task.id
        });
        await this.logDecision("requested", ensured.approval, task.assignee);
      }
    }

    for (const approval of this.approvals.list({ status: "pending", limit: 1000 })) {
      if (approval.kind !== "task_review" || !approval.taskId) continue;
      const task = byId.get(approval.taskId);
      if (!task) {
        this.approvals.reconcile(approval.id, "cancelled", "Linked task no longer exists.");
        continue;
      }
      if (task.status !== "review") this.reconcileFromTask(approval, task);
    }
  }

  private reconcileFromTask(approval: ApprovalRequest, task: TaskRecord): ApprovalRequest | null {
    if (task.status === "done") {
      return this.approvals.reconcile(
        approval.id,
        "approved",
        "Recovered from linked task state."
      );
    }
    if (
      task.status === "in_progress"
      && task.notes.at(-1)?.text.toLowerCase().startsWith("sent back:")
    ) {
      return this.approvals.reconcile(
        approval.id,
        "rejected",
        "Recovered from linked task state."
      );
    }
    if (task.status !== "review") {
      return this.approvals.reconcile(
        approval.id,
        "cancelled",
        `Linked task moved to ${task.status}.`
      );
    }
    return null;
  }

  private taskVisualization(tasks: TaskRecord[]): TaskVisualization {
    const byStatus = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, 0])
    ) as Record<TaskStatus, number>;
    for (const task of tasks) byStatus[task.status]++;
    return {
      total: tasks.length,
      active: tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length,
      byStatus,
      recent: [...tasks]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20)
    };
  }

  private memoryVisualization(
    stats: { total: number; byType: Record<string, number>; byAgent: Record<string, number> },
    recent: MemoryStoreEntry[]
  ): MemoryVisualization {
    return { ...stats, recent };
  }

  private auditVisualization(
    records: AuditRecord[],
    integrity: Awaited<ReturnType<AuditLogger["verify"]>>
  ): AuditVisualization {
    const byAction: Record<string, number> = {};
    for (const record of records) {
      byAction[record.action] = (byAction[record.action] ?? 0) + 1;
    }
    return {
      total: records.length,
      policyDenials: records.filter((record) => record.action === "policy_denied").length,
      byAction,
      recent: records.slice(0, 30),
      integrity
    };
  }

  private countApprovalRisk(approvals: ApprovalRequest[]): Record<ApprovalRisk, number> {
    const counts: Record<ApprovalRisk, number> = { low: 0, medium: 0, high: 0 };
    for (const approval of approvals) counts[approval.risk]++;
    return counts;
  }

  private async logDecision(
    action: string,
    approval: ApprovalRequest,
    actor: string,
    note?: string
  ): Promise<void> {
    await this.audit.log(this.options.workspaceRoot, {
      action: "tool",
      target: `approval:${approval.id}`,
      agentId: actor,
      details: {
        controlCenterAction: action,
        approvalKind: approval.kind,
        risk: approval.risk,
        taskId: approval.taskId,
        version: approval.version,
        payloadHash: approval.payloadHash,
        approvalCount: approval.approvalCount,
        requiredApprovals: approval.requiredApprovals,
        note
      }
    });
  }
}
