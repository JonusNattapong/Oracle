import crypto from "node:crypto";
import type { ChecklistItem, TaskNote, TaskStatus } from "../tasks/store.js";
import type { RuntimeDatabase } from "./database.js";
import type { RuntimeEventBus } from "./events.js";

export interface SwarmIdentity {
  projectId: string;
  agentName: string;
  role: string;
}

export interface SwarmToken {
  id: string;
  projectId: string;
  agentName: string;
  role: string;
  token: string;
  createdAt: string;
}

export interface SwarmAgent {
  projectId: string;
  name: string;
  role: string;
  connectedAt: string;
  lastSeenAt: string;
  status: "online" | "idle" | "offline";
}

export interface SwarmMessage {
  id: string;
  projectId: string;
  ts: string;
  from: string;
  to: string;
  subject?: string;
  body: string;
  replyTo?: string;
  taskId?: string;
  readBy: string[];
}

export interface SwarmTask {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  createdBy: string;
  assignee: string;
  status: TaskStatus;
  checklist: ChecklistItem[];
  notes: TaskNote[];
  createdAt: string;
  updatedAt: string;
}

interface TokenRow {
  project_id: string;
  agent_name: string;
  role: string;
}

interface AgentRow {
  project_id: string;
  name: string;
  role: string;
  connected_at: string;
  last_seen_at: string;
}

interface MessageRow {
  id: string;
  project_id: string;
  from_agent: string;
  to_agent: string;
  subject: string | null;
  body: string;
  reply_to: string | null;
  task_id: string | null;
  created_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  created_by: string;
  assignee: string;
  status: TaskStatus;
  checklist_json: string;
  notes_json: string;
  created_at: string;
  updated_at: string;
}

const ACTIVE_STATUSES: TaskStatus[] = ["pending", "in_progress", "review", "blocked"];
const VALID_TASK_STATUSES = new Set<TaskStatus>([
  "pending",
  "in_progress",
  "review",
  "done",
  "blocked",
  "cancelled"
]);

/**
 * Durable collaboration service for agents connected from different
 * machines. It deliberately carries coordination data only: it never
 * accepts shell commands or file mutations from a remote peer.
 */
export class RemoteSwarmService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly events: RuntimeEventBus
  ) {}

  issueToken(input: {
    projectId: string;
    projectName?: string;
    agentName: string;
    role?: string;
  }): SwarmToken {
    const projectId = this.projectId(input.projectId);
    const agentName = this.agentName(input.agentName);
    const role = this.role(input.role ?? "worker");
    const createdAt = new Date().toISOString();
    const token = `oracle_swarm_${crypto.randomBytes(32).toString("base64url")}`;
    const id = `token-${crypto.randomBytes(8).toString("hex")}`;

    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      this.database.connection.prepare(`
        INSERT INTO swarm_projects (id, name, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name
      `).run(projectId, input.projectName?.trim() || projectId, createdAt);
      this.database.connection.prepare(`
        INSERT INTO swarm_tokens (
          id, project_id, agent_name, role, token_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, projectId, agentName, role, this.tokenHash(token), createdAt);
      this.database.connection.exec("COMMIT");
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }

    this.events.publish("swarm.token.created", {
      projectId,
      agentName,
      role,
      tokenId: id
    });
    return { id, projectId, agentName, role, token, createdAt };
  }

  revokeToken(tokenId: string): boolean {
    const result = this.database.connection.prepare(`
      UPDATE swarm_tokens SET revoked_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), tokenId);
    return result.changes > 0;
  }

  authenticate(token: string): SwarmIdentity | null {
    if (!token.startsWith("oracle_swarm_")) return null;
    const row = this.database.connection.prepare(`
      SELECT project_id, agent_name, role
      FROM swarm_tokens
      WHERE token_hash = ? AND revoked_at IS NULL
    `).get(this.tokenHash(token)) as TokenRow | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id,
      agentName: row.agent_name,
      role: row.role
    };
  }

  connect(identity: SwarmIdentity): SwarmAgent {
    const now = new Date().toISOString();
    this.database.connection.prepare(`
      INSERT INTO swarm_agents (
        project_id, name, role, connected_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, name) DO UPDATE SET
        role = excluded.role,
        last_seen_at = excluded.last_seen_at
    `).run(
      identity.projectId,
      identity.agentName,
      identity.role,
      now,
      now
    );
    const agent = this.getAgent(identity.projectId, identity.agentName)!;
    this.events.publish("swarm.agent.connected", {
      projectId: identity.projectId,
      agent
    });
    return agent;
  }

  heartbeat(identity: SwarmIdentity): SwarmAgent {
    const now = new Date().toISOString();
    const result = this.database.connection.prepare(`
      UPDATE swarm_agents
      SET role = ?, last_seen_at = ?
      WHERE project_id = ? AND name = ?
    `).run(identity.role, now, identity.projectId, identity.agentName);
    if (result.changes === 0) return this.connect(identity);
    const agent = this.getAgent(identity.projectId, identity.agentName)!;
    this.events.publish("swarm.agent.heartbeat", {
      projectId: identity.projectId,
      agentName: identity.agentName,
      lastSeenAt: agent.lastSeenAt
    });
    return agent;
  }

  listAgents(projectId: string): SwarmAgent[] {
    const rows = this.database.connection.prepare(`
      SELECT project_id, name, role, connected_at, last_seen_at
      FROM swarm_agents
      WHERE project_id = ?
      ORDER BY name ASC
    `).all(projectId) as unknown as AgentRow[];
    return rows.map((row) => this.agentFromRow(row));
  }

  sendMessage(identity: SwarmIdentity, input: {
    to: string;
    body: string;
    subject?: string;
    replyTo?: string;
    taskId?: string;
  }): SwarmMessage {
    const to = input.to === "*" ? "*" : this.agentName(input.to);
    const body = this.nonEmpty(input.body, "body");
    const subject = input.subject?.trim() || undefined;
    if (subject && subject.length > 300) throw new Error("subject must be at most 300 characters.");
    if (body.length > 100_000) throw new Error("body must be at most 100000 characters.");
    const now = new Date().toISOString();
    const id = this.newId("msg");
    this.database.connection.prepare(`
      INSERT INTO swarm_messages (
        id, project_id, from_agent, to_agent, subject, body, reply_to,
        task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      identity.projectId,
      identity.agentName,
      to,
      subject ?? null,
      body,
      input.replyTo ?? null,
      input.taskId ?? null,
      now
    );
    this.heartbeat(identity);
    const message = this.getMessage(identity.projectId, id)!;
    this.events.publish("swarm.message.created", {
      projectId: identity.projectId,
      message
    });
    return message;
  }

  getMessage(projectId: string, id: string): SwarmMessage | null {
    const row = this.database.connection.prepare(`
      SELECT * FROM swarm_messages WHERE project_id = ? AND id = ?
    `).get(projectId, id) as MessageRow | undefined;
    return row ? this.messageFromRow(row) : null;
  }

  inbox(identity: SwarmIdentity, input: {
    unreadOnly?: boolean;
    limit?: number;
  } = {}): SwarmMessage[] {
    const unreadOnly = input.unreadOnly ?? true;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    this.heartbeat(identity);
    const rows = this.database.connection.prepare(`
      SELECT m.*
      FROM swarm_messages m
      WHERE m.project_id = ?
        AND (m.to_agent = ? OR m.to_agent = '*')
        AND m.from_agent != ?
        AND (
          ? = 0 OR NOT EXISTS (
            SELECT 1 FROM swarm_message_reads r
            WHERE r.message_id = m.id AND r.agent_name = ?
          )
        )
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(
      identity.projectId,
      identity.agentName,
      identity.agentName,
      unreadOnly ? 1 : 0,
      identity.agentName,
      limit
    ) as unknown as MessageRow[];
    return rows.reverse().map((row) => this.messageFromRow(row));
  }

  acknowledge(identity: SwarmIdentity, ids: string[]): string[] {
    const now = new Date().toISOString();
    const acked: string[] = [];
    const find = this.database.connection.prepare(`
      SELECT id FROM swarm_messages
      WHERE project_id = ? AND id = ?
        AND (to_agent = ? OR to_agent = '*')
        AND from_agent != ?
    `);
    const insert = this.database.connection.prepare(`
      INSERT OR IGNORE INTO swarm_message_reads (message_id, agent_name, read_at)
      VALUES (?, ?, ?)
    `);
    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        if (!find.get(identity.projectId, id, identity.agentName, identity.agentName)) continue;
        if (insert.run(id, identity.agentName, now).changes > 0) acked.push(id);
      }
      this.database.connection.exec("COMMIT");
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }
    this.heartbeat(identity);
    if (acked.length) {
      this.events.publish("swarm.message.acknowledged", {
        projectId: identity.projectId,
        agentName: identity.agentName,
        messageIds: acked
      });
    }
    return acked;
  }

  createTask(identity: SwarmIdentity, input: {
    title: string;
    description?: string;
    assignee: string;
    checklist?: string[];
  }): SwarmTask {
    const now = new Date().toISOString();
    const task: SwarmTask = {
      id: this.newId("task"),
      projectId: identity.projectId,
      title: this.nonEmpty(input.title, "title"),
      description: input.description?.trim() || undefined,
      createdBy: identity.agentName,
      assignee: this.agentName(input.assignee),
      status: "pending",
      checklist: (input.checklist ?? []).map((text) => ({
        text: this.nonEmpty(text, "checklist item"),
        done: false
      })),
      notes: [],
      createdAt: now,
      updatedAt: now
    };
    this.writeTask(task);
    this.sendMessage(identity, {
      to: task.assignee,
      subject: `Task assigned: ${task.title}`,
      body: `New task ${task.id}: ${task.title}${task.description ? `\n${task.description}` : ""}`,
      taskId: task.id
    });
    this.events.publish("swarm.task.created", {
      projectId: identity.projectId,
      task
    });
    return task;
  }

  getTask(projectId: string, id: string): SwarmTask | null {
    const row = this.database.connection.prepare(`
      SELECT * FROM swarm_tasks WHERE project_id = ? AND id = ?
    `).get(projectId, id) as TaskRow | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  listTasks(identity: SwarmIdentity, input: {
    assignee?: string;
    createdBy?: string;
    status?: TaskStatus;
    activeOnly?: boolean;
  } = {}): SwarmTask[] {
    this.heartbeat(identity);
    const rows = this.database.connection.prepare(`
      SELECT * FROM swarm_tasks
      WHERE project_id = ?
      ORDER BY updated_at ASC
    `).all(identity.projectId) as unknown as TaskRow[];
    return rows
      .map((row) => this.taskFromRow(row))
      .filter((task) => !input.assignee || task.assignee === input.assignee)
      .filter((task) => !input.createdBy || task.createdBy === input.createdBy)
      .filter((task) => !input.status || task.status === input.status)
      .filter((task) => !input.activeOnly || ACTIVE_STATUSES.includes(task.status));
  }

  updateTask(identity: SwarmIdentity, id: string, input: {
    status?: TaskStatus;
    note?: string;
  }): SwarmTask {
    const task = this.requireTask(identity.projectId, id);
    this.assertTaskParticipant(identity, task);
    if (input.status) {
      if (!VALID_TASK_STATUSES.has(input.status)) throw new Error("Invalid task status.");
      if (input.status === "done") throw new Error("Use task close to mark a task done.");
      if (input.status === "review") {
        throw new Error("Use task submit to enter review after verification.");
      }
      task.status = input.status;
    }
    if (input.note?.trim()) {
      task.notes.push({
        ts: new Date().toISOString(),
        agent: identity.agentName,
        text: input.note.trim()
      });
    }
    task.updatedAt = new Date().toISOString();
    this.writeTask(task);
    this.publishTask("swarm.task.updated", task);
    return task;
  }

  checkTask(identity: SwarmIdentity, id: string, index: number, done: boolean): SwarmTask {
    const task = this.requireTask(identity.projectId, id);
    if (task.assignee !== identity.agentName) {
      throw new Error("Only the assignee can change the verification checklist.");
    }
    if (!Number.isInteger(index) || !task.checklist[index]) {
      throw new Error(`Checklist item not found: ${index}`);
    }
    task.checklist[index].done = done;
    task.updatedAt = new Date().toISOString();
    this.writeTask(task);
    this.publishTask("swarm.task.updated", task);
    return task;
  }

  submitTask(identity: SwarmIdentity, id: string, summary: string): SwarmTask {
    const task = this.requireTask(identity.projectId, id);
    if (task.assignee !== identity.agentName) {
      throw new Error("Only the assignee can submit this task.");
    }
    const unchecked = task.checklist.filter((item) => !item.done);
    if (unchecked.length) {
      throw new Error(
        `Cannot submit — ${unchecked.length} checklist item(s) unchecked: ${
          unchecked.map((item) => item.text).join("; ")
        }`
      );
    }
    task.status = "review";
    task.notes.push({
      ts: new Date().toISOString(),
      agent: identity.agentName,
      text: `Submitted for review: ${this.nonEmpty(summary, "summary")}`
    });
    task.updatedAt = new Date().toISOString();
    this.writeTask(task);
    this.sendMessage(identity, {
      to: task.createdBy,
      subject: `Task ready for review: ${task.title}`,
      body: `Task ${task.id} is ready for review.\n${summary}`,
      taskId: task.id
    });
    this.publishTask("swarm.task.submitted", task);
    return task;
  }

  closeTask(identity: SwarmIdentity, id: string, input: {
    approved: boolean;
    note?: string;
  }): SwarmTask {
    const task = this.requireTask(identity.projectId, id);
    if (task.createdBy !== identity.agentName) {
      throw new Error("Only the task creator can close or reject this task.");
    }
    if (task.status !== "review") throw new Error("Task must be in review before it can be closed.");
    task.status = input.approved ? "done" : "in_progress";
    if (input.note?.trim()) {
      task.notes.push({
        ts: new Date().toISOString(),
        agent: identity.agentName,
        text: input.note.trim()
      });
    }
    task.updatedAt = new Date().toISOString();
    this.writeTask(task);
    this.sendMessage(identity, {
      to: task.assignee,
      subject: input.approved
        ? `Task approved: ${task.title}`
        : `Task needs changes: ${task.title}`,
      body: input.approved
        ? `Task ${task.id} was approved.`
        : `Task ${task.id} was returned.${input.note ? `\n${input.note}` : ""}`,
      taskId: task.id
    });
    this.publishTask(input.approved ? "swarm.task.closed" : "swarm.task.rejected", task);
    return task;
  }

  private getAgent(projectId: string, name: string): SwarmAgent | null {
    const row = this.database.connection.prepare(`
      SELECT project_id, name, role, connected_at, last_seen_at
      FROM swarm_agents WHERE project_id = ? AND name = ?
    `).get(projectId, name) as AgentRow | undefined;
    return row ? this.agentFromRow(row) : null;
  }

  private agentFromRow(row: AgentRow): SwarmAgent {
    const age = Date.now() - Date.parse(row.last_seen_at);
    return {
      projectId: row.project_id,
      name: row.name,
      role: row.role,
      connectedAt: row.connected_at,
      lastSeenAt: row.last_seen_at,
      status: age <= 60_000 ? "online" : age <= 5 * 60_000 ? "idle" : "offline"
    };
  }

  private messageFromRow(row: MessageRow): SwarmMessage {
    const reads = this.database.connection.prepare(`
      SELECT agent_name FROM swarm_message_reads
      WHERE message_id = ? ORDER BY agent_name ASC
    `).all(row.id) as unknown as Array<{ agent_name: string }>;
    return {
      id: row.id,
      projectId: row.project_id,
      ts: row.created_at,
      from: row.from_agent,
      to: row.to_agent,
      subject: row.subject ?? undefined,
      body: row.body,
      replyTo: row.reply_to ?? undefined,
      taskId: row.task_id ?? undefined,
      readBy: reads.map((read) => read.agent_name)
    };
  }

  private taskFromRow(row: TaskRow): SwarmTask {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description ?? undefined,
      createdBy: row.created_by,
      assignee: row.assignee,
      status: row.status,
      checklist: JSON.parse(row.checklist_json) as ChecklistItem[],
      notes: JSON.parse(row.notes_json) as TaskNote[],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private writeTask(task: SwarmTask): void {
    this.database.connection.prepare(`
      INSERT INTO swarm_tasks (
        id, project_id, title, description, created_by, assignee, status,
        checklist_json, notes_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        assignee = excluded.assignee,
        status = excluded.status,
        checklist_json = excluded.checklist_json,
        notes_json = excluded.notes_json,
        updated_at = excluded.updated_at
    `).run(
      task.id,
      task.projectId,
      task.title,
      task.description ?? null,
      task.createdBy,
      task.assignee,
      task.status,
      JSON.stringify(task.checklist),
      JSON.stringify(task.notes),
      task.createdAt,
      task.updatedAt
    );
  }

  private requireTask(projectId: string, id: string): SwarmTask {
    const task = this.getTask(projectId, id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  private assertTaskParticipant(identity: SwarmIdentity, task: SwarmTask): void {
    if (task.assignee !== identity.agentName && task.createdBy !== identity.agentName) {
      throw new Error("Only the task creator or assignee can update this task.");
    }
  }

  private publishTask(type: string, task: SwarmTask): void {
    this.events.publish(type, { projectId: task.projectId, task });
  }

  private newId(prefix: string): string {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `${prefix}-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  }

  private tokenHash(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private projectId(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized)) {
      throw new Error("projectId must be a lowercase slug of at most 63 characters.");
    }
    return normalized;
  }

  private agentName(value: string): string {
    const normalized = value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(normalized)) {
      throw new Error("agent name may contain letters, numbers, dot, underscore, and dash.");
    }
    return normalized;
  }

  private role(value: string): string {
    const normalized = value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(normalized)) {
      throw new Error("role contains unsupported characters.");
    }
    return normalized;
  }

  private nonEmpty(value: string, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
    return value.trim();
  }
}
