import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serializeOracleError } from "../errors.js";
import type { TaskStore, TaskStatus } from "../tasks/store.js";
import type { MessageStore } from "../messaging/store.js";
import type { AgentRegistry } from "../messaging/registry.js";
import { CoordinationService } from "../coordination/service.js";

function success(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>
  };
}

const STATUS_ENUM = z.enum(["pending", "in_progress", "review", "done", "blocked", "cancelled"]);

/**
 * Injected alongside MESSAGING_INSTRUCTIONS into the MCP client's context on
 * connect, so every agent learns the plan/track/verify/report flow without
 * anyone telling it manually.
 */
export const TASK_INSTRUCTIONS = [
  "A task tracker sits on top of the message bus for planning and accountability.",
  "As a lead: use oracle_task_create per unit of work with a checklist. This auto-messages the assignee.",
  "As an assignee: use oracle_task_update to log progress as you go. Check off checklist items via oracle_task_checklist as you complete them, not preemptively.",
  "Before reporting done: call oracle_task_submit. It blocks if any checklist item is unchecked, then auto-notifies the creator.",
  "As a reviewer: oracle_task_get shows the full checklist and notes; oracle_task_close with approved=true finishes it, or approved=false sends it back.",
  "For decisions requiring multiple reviewers: create a persistent proposal with oracle_task_propose, then vote with oracle_task_vote.",
  "If a process stopped between a task update and notification delivery, call oracle_coordination_recover. It safely replays pending linked messages without duplicates.",
  "Use oracle_task_list to see open work. Leads use oracle_task_board for an ASCII board view."
].join(" ");

function formatTask(t: { id: string; title: string; status: TaskStatus; assignee: string; createdBy: string; checklist: { text: string; done: boolean }[] }): string {
  const checklist = t.checklist.length
    ? "\n  " + t.checklist.map((c) => `[${c.done ? "x" : " "}] ${c.text}`).join("\n  ")
    : "";
  return `${t.id} | ${t.status} | ${t.title} | ${t.createdBy} -> ${t.assignee}${checklist}`;
}

/**
 * Register task-planning tools (`oracle_task_*`) that build on the message
 * bus: a lead breaks work into tasks and assigns them, agents track
 * progress and check off a verification checklist, then submit for review
 * — which auto-reports to the task creator over oracle_msg_send so no one
 * has to manually "tell the boss it's done."
 */
function boardRow(task: { id: string; title: string; assignee: string; createdBy: string; status: TaskStatus }): string {
  const title = task.title.length > 42 ? `${task.title.slice(0, 39)}...` : task.title;
  return `| ${task.status.padEnd(11)} | ${task.assignee.padEnd(20)} | ${title.padEnd(42)} | ${task.id} |`;
}

/** Render a terminal-safe overview so every MCP client can inspect the work. */
export function formatTaskBoard(
  agents: Array<{ name: string; role?: string; active: boolean }>,
  tasks: Array<{ id: string; title: string; assignee: string; createdBy: string; status: TaskStatus }>
): string {
  const agentLines = agents.length
    ? agents.map((agent) => `| ${agent.name.padEnd(22)} | ${(agent.active ? "ACTIVE" : "idle").padEnd(6)} | ${(agent.role ?? "-").slice(0, 48).padEnd(48)} |`)
    : ["| (no registered agents)                                                    |"];
  const todoLines = tasks.length ? tasks.map(boardRow) : ["| (no TODOs on this board)                                                      |"];
  return [
    "+--------------------------+--------+--------------------------------------------------+",
    "| AGENT ROSTER             | STATE  | ROLE                                             |",
    "+--------------------------+--------+--------------------------------------------------+",
    ...agentLines,
    "+--------------------------+--------+--------------------------------------------------+",
    "",
    "+-------------+----------------------+--------------------------------------------+--------------------+",
    "| STATUS      | ASSIGNEE             | MAIN TODO                                  | TASK ID            |",
    "+-------------+----------------------+--------------------------------------------+--------------------+",
    ...todoLines,
    "+-------------+----------------------+--------------------------------------------+--------------------+"
  ].join("\n");
}

export function registerTaskTools(
  server: McpServer,
  tasks: TaskStore,
  messages: MessageStore,
  registry: AgentRegistry,
  coordination: CoordinationService = new CoordinationService(tasks, messages)
): void {
  server.registerTool(
    "oracle_task_board",
    {
      title: "Show ASCII Work Board",
      description: "ASCII work board: agents + main TODOs. Filter by createdBy, hide done with activeOnly.",
      inputSchema: {
        createdBy: z.string().min(1).optional().describe("Optional lead/creator name, e.g. claude-lead"),
        activeOnly: z.boolean().default(true)
      }
    },
    async ({ createdBy, activeOnly }) => {
      try {
        const [agents, list] = await Promise.all([
          registry.list(),
          tasks.list({ createdBy, activeOnly })
        ]);
        const board = formatTaskBoard(agents, list);
        return success(board, {
          createdBy: createdBy ?? null,
          activeOnly,
          agents: agents as unknown as Record<string, unknown>[],
          tasks: list as unknown as Record<string, unknown>[]
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_create",
    {
      title: "Create and Assign Task",
      description:
        "Create and assign a task with optional checklist. Auto-notifies the assignee.",
      inputSchema: {
        title: z.string().min(1).max(200),
        description: z.string().max(5000).optional(),
        createdBy: z.string().min(1).describe("Your agent name (the one who will review/close this task)"),
        assignee: z.string().min(1).describe("Agent responsible for doing the work"),
        checklist: z.array(z.string().min(1)).max(50).optional().describe("Verification steps required before submit"),
        parentId: z.string().optional().describe("Parent task id, for breaking a larger plan into subtasks")
      }
    },
    async ({ title, description, createdBy, assignee, checklist, parentId }) => {
      try {
        const task = await coordination.createTask({ title, description, createdBy, assignee, checklist, parentId });
        return success(`Created ${task.id}, assigned to ${assignee}.`, { task: task as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_breakdown",
    {
      title: "Breakdown High-Level Goal Into Tasks",
      description:
        "Decompose a high-level goal prompt into actionable sub-tasks with verification checklists.",
      inputSchema: {
        goal: z.string().min(1).max(2000).describe("High-level goal prompt"),
        createdBy: z.string().min(1).default("lead").describe("Your agent name"),
        defaultAssignee: z.string().min(1).default("coder").describe("Target assignee for implementation sub-tasks"),
        workflowId: z.string().optional().describe("Optional workflow grouping ID")
      }
    },
    async ({ goal, createdBy, defaultAssignee, workflowId }) => {
      try {
        const created = await tasks.createBreakdown(goal, { createdBy, defaultAssignee, workflowId });
        const summary = created.map((t) => formatTask(t)).join("\n");
        return success(`Created ${created.length} sub-task(s) with verification checklists:\n${summary}`, {
          count: created.length,
          tasks: created as unknown as Record<string, unknown>[]
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_list",
    {
      title: "List Tasks",
      description: "List tasks, optionally filtered by assignee, creator, or status. activeOnly excludes done/cancelled.",
      inputSchema: {
        assignee: z.string().optional(),
        createdBy: z.string().optional(),
        status: STATUS_ENUM.optional(),
        activeOnly: z.boolean().default(false)
      }
    },
    async ({ assignee, createdBy, status, activeOnly }) => {
      try {
        const list = await tasks.list({ assignee, createdBy, status, activeOnly });
        return success(
          list.length ? list.map(formatTask).join("\n") : "No tasks found.",
          { count: list.length, tasks: list as unknown as Record<string, unknown>[] }
        );
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_get",
    {
      title: "Get Task Detail",
      description: "Full task detail with checklist and progress-note history.",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      try {
        const task = await tasks.get(id);
        if (!task) return success(`Not found: ${id}`, { found: false });
        const notes = task.notes.map((n) => `  [${n.ts}] ${n.agent}: ${n.text}`).join("\n");
        return success(`${formatTask(task)}${notes ? `\nNotes:\n${notes}` : ""}`, {
          found: true,
          task: task as unknown as Record<string, unknown>
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_update",
    {
      title: "Update Task Progress",
      description:
        "Record progress: add a note and/or change status. Use liberally — it's the audit trail.",
      inputSchema: {
        id: z.string().min(1),
        agent: z.string().min(1).describe("Your agent name"),
        note: z.string().max(2000).optional(),
        status: STATUS_ENUM.optional()
      }
    },
    async ({ id, agent, note, status }) => {
      try {
        const task = await tasks.update(id, agent, { note, status });
        if (!task) return failure(new Error(`Task not found: ${id}`));
        return success(`Updated ${id}.`, { task: task as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_checklist",
    {
      title: "Check Off a Verification Item",
      description: "Check or uncheck a checklist item by 0-based index.",
      inputSchema: {
        id: z.string().min(1),
        index: z.number().int().min(0),
        done: z.boolean().default(true)
      }
    },
    async ({ id, index, done }) => {
      try {
        const task = await tasks.setChecklistItem(id, index, done);
        if (!task) return failure(new Error(`Task or checklist index not found: ${id}[${index}]`));
        return success(`${done ? "Checked" : "Unchecked"} item ${index}.`, { task: task as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_submit",
    {
      title: "Submit Task for Review",
      description:
        "Submit for review. Fails if any checklist item is unchecked. Auto-notifies the task creator.",
      inputSchema: {
        id: z.string().min(1),
        agent: z.string().min(1).describe("Your agent name"),
        summary: z.string().min(1).max(2000).describe("What you did, for the reviewer")
      }
    },
    async ({ id, agent, summary }) => {
      try {
        const task = await coordination.submitTask(id, agent, summary);
        return success(`Submitted ${id} for review; ${task.createdBy} notified.`, { task: task as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_close",
    {
      title: "Close (Approve or Reject) a Task",
      description:
        "Approve (marks done) or reject (sends back to in_progress with note).",
      inputSchema: {
        id: z.string().min(1),
        agent: z.string().min(1).describe("Your agent name (the reviewer)"),
        approved: z.boolean(),
        note: z.string().max(2000).optional()
      }
    },
    async ({ id, agent, approved, note }) => {
      try {
        const task = await coordination.closeTask(id, agent, approved, note);
        return success(approved ? `Closed ${id} as done.` : `Sent ${id} back to in_progress.`, {
          task: task as unknown as Record<string, unknown>
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_propose",
    {
      title: "Create Task Consensus Proposal",
      description: "Create a persistent proposal attached to a task for multi-agent review and voting.",
      inputSchema: {
        taskId: z.string().min(1),
        proposerAgentId: z.string().min(1),
        proposedAction: z.string().min(1).max(5000),
        requiredQuorum: z.number().int().min(1).max(50).default(2),
        approvalThresholdRatio: z.number().min(0).max(1).default(0.66)
      }
    },
    async ({ taskId, proposerAgentId, proposedAction, requiredQuorum, approvalThresholdRatio }) => {
      try {
        const proposal = await tasks.createProposal(taskId, proposerAgentId, proposedAction, {
          requiredQuorum,
          approvalThresholdRatio
        });
        return success(`Created proposal ${proposal.id} for task ${taskId}.`, {
          proposal: proposal as unknown as Record<string, unknown>
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_vote",
    {
      title: "Cast Vote on Task Proposal",
      description: "Cast a consensus vote ('approve' | 'reject' | 'abstain') on a task proposal with justification.",
      inputSchema: {
        proposalId: z.string().min(1),
        agentId: z.string().min(1),
        decision: z.enum(["approve", "reject", "abstain"]),
        justification: z.string().min(1).max(1000)
      }
    },
    async ({ proposalId, agentId, decision, justification }) => {
      try {
        const result = await coordination.castTaskProposalVote(proposalId, agentId, decision, justification);
        if (!result) return failure(new Error(`Proposal not found: ${proposalId}`));
        const updated = result.proposal;
        const activeVotes = updated.votes.filter((vote) => vote.decision !== "abstain").length;
        const status = updated.status === "approved" ? "APPROVED"
          : updated.status === "rejected" ? "REJECTED"
          : `pending (${activeVotes}/${updated.requiredQuorum} voted)`;
        return success(`Vote recorded: ${agentId} → ${decision} — ${status}`, {
          proposalId,
          agentId,
          decision,
          status: updated.status,
          voteCount: updated.votes.length,
          taskId: result.task.id
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_coordination_recover",
    {
      title: "Recover Coordination Workflows",
      description:
        "Reconcile persistent workflow/task/proposal links and replay pending task notifications idempotently after interruption.",
      inputSchema: {}
    },
    async () => {
      try {
        const report = await coordination.recover();
        const text = [
          `Recovery complete: ${report.messagesDelivered} message(s) delivered.`,
          `${report.workflowsScanned} workflow(s) scanned, ${report.workflowsRepaired} repaired, ${report.tasksCreated} task(s) recreated.`,
          report.errors.length ? `${report.errors.length} workflow error(s).` : "No recovery errors."
        ].join(" ");
        return success(text, { report: report as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );
}
