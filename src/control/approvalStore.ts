import crypto from "node:crypto";
import type { RuntimeDatabase } from "../runtime/database.js";
import { approvalPayloadHash } from "./payload.js";
import type {
  ApprovalDecision,
  ApprovalExecution,
  ApprovalExecutionStatus,
  ApprovalKind,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalStatus,
  ApprovalVote,
  CompleteApprovalExecutionInput,
  CreateApprovalInput
} from "./types.js";

interface ApprovalRow {
  id: string;
  source_key: string | null;
  kind: ApprovalKind;
  title: string;
  description: string | null;
  requested_by: string;
  assigned_to: string;
  authorized_reviewers_json: string;
  risk: ApprovalRisk;
  status: ApprovalStatus;
  version: number;
  required_approvals: number;
  task_id: string | null;
  message_id: string | null;
  workflow_id: string | null;
  expires_at: string | null;
  payload_hash: string | null;
  action_type: string | null;
  action_payload_json: string | null;
  checkpoint_id: string | null;
  local_only: number;
  telegram_token: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  notified_at: string | null;
}

interface VoteRow {
  actor: string;
  decision: "approve" | "reject";
  channel: ApprovalVote["channel"];
  note: string | null;
  created_at: string;
}

interface ExecutionRow {
  id: string;
  approval_id: string;
  payload_hash: string;
  status: ApprovalExecutionStatus;
  claimed_by: string;
  claimed_at: string;
  completed_at: string | null;
  result_json: string | null;
}

export class ApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalConflictError";
  }
}

export class ApprovalAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalAuthorizationError";
  }
}

export class ApprovalStore {
  constructor(private readonly runtime: RuntimeDatabase) {}

  create(input: CreateApprovalInput): ApprovalRequest {
    return this.insert({
      ...input,
      kind: input.kind ?? "custom",
      risk: input.risk ?? "medium"
    });
  }

  ensureTaskReview(input: {
    taskId: string;
    reviewKey: string;
    title: string;
    description?: string;
    requestedBy: string;
    assignedTo: string;
    messageId?: string;
    workflowId?: string;
  }): { approval: ApprovalRequest; created: boolean } {
    const sourceKey = `task:${input.taskId}:${input.reviewKey}`;
    const existing = this.getBySourceKey(sourceKey);
    if (existing) {
      if (existing.status !== "pending") {
        const now = new Date().toISOString();
        this.runtime.connection.exec("BEGIN IMMEDIATE");
        try {
          this.runtime.connection.prepare("DELETE FROM approval_votes WHERE approval_id = ?").run(existing.id);
          this.runtime.connection.prepare(`
            UPDATE approval_requests
            SET status = 'pending', title = ?, description = ?, requested_by = ?,
                assigned_to = ?, authorized_reviewers_json = ?, message_id = ?,
                workflow_id = ?, version = version + 1, required_approvals = 1,
                expires_at = NULL, updated_at = ?, decided_at = NULL,
                decided_by = NULL, decision_note = NULL, notified_at = NULL
            WHERE id = ?
          `).run(
            input.title,
            input.description ?? null,
            input.requestedBy,
            input.assignedTo,
            JSON.stringify([input.assignedTo]),
            input.messageId ?? null,
            input.workflowId ?? null,
            now,
            existing.id
          );
          this.runtime.connection.exec("COMMIT");
        } catch (error) {
          this.runtime.connection.exec("ROLLBACK");
          throw error;
        }
        return { approval: this.get(existing.id)!, created: true };
      }
      return { approval: existing, created: false };
    }
    return {
      approval: this.insert({
        ...input,
        sourceKey,
        kind: "task_review",
        risk: "medium",
        requiredApprovals: 1,
        authorizedReviewers: [input.assignedTo]
      }),
      created: true
    };
  }

  get(id: string): ApprovalRequest | null {
    this.expireDue();
    return this.getWithoutExpiry(id);
  }

  getBySourceKey(sourceKey: string): ApprovalRequest | null {
    this.expireDue();
    const row = this.runtime.connection.prepare(
      "SELECT * FROM approval_requests WHERE source_key = ?"
    ).get(sourceKey) as ApprovalRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  getByTelegramToken(token: string): ApprovalRequest | null {
    this.expireDue();
    const row = this.runtime.connection.prepare(
      "SELECT * FROM approval_requests WHERE telegram_token = ?"
    ).get(token) as ApprovalRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  list(options: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRequest[] {
    this.expireDue();
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const rows = options.status
      ? this.runtime.connection.prepare(`
          SELECT * FROM approval_requests
          WHERE status = ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(options.status, limit)
      : this.runtime.connection.prepare(`
          SELECT * FROM approval_requests
          ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
          LIMIT ?
        `).all(limit);
    return (rows as unknown as ApprovalRow[]).map((row) => this.fromRow(row));
  }

  assertDecidable(id: string, decision: ApprovalDecision): ApprovalRequest {
    const approval = this.get(id);
    if (!approval) throw new Error(`Approval not found: ${id}`);
    if (approval.status !== "pending") {
      throw new ApprovalConflictError(`Approval ${id} is already ${approval.status}.`);
    }
    if (approval.version !== decision.expectedVersion) {
      throw new ApprovalConflictError(
        `Approval ${id} changed (expected version ${decision.expectedVersion}, current ${approval.version}). Refresh and retry.`
      );
    }
    if (!approval.authorizedReviewers.includes(decision.decidedBy)) {
      throw new ApprovalAuthorizationError(
        `${decision.decidedBy} is not authorized to decide approval ${id}.`
      );
    }
    if (approval.requestedBy === decision.decidedBy) {
      throw new ApprovalAuthorizationError(
        `${decision.decidedBy} cannot approve its own request ${id}.`
      );
    }
    if (approval.votes.some((vote) => vote.actor === decision.decidedBy)) {
      throw new ApprovalConflictError(`${decision.decidedBy} has already voted on approval ${id}.`);
    }
    return approval;
  }

  decide(id: string, decision: ApprovalDecision): ApprovalRequest {
    this.assertDecidable(id, decision);
    const now = new Date().toISOString();
    this.runtime.connection.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWithoutExpiry(id);
      if (!current || current.status !== "pending" || current.version !== decision.expectedVersion) {
        throw new ApprovalConflictError(`Approval ${id} changed before the decision was recorded.`);
      }
      if (!current.authorizedReviewers.includes(decision.decidedBy)) {
        throw new ApprovalAuthorizationError(
          `${decision.decidedBy} is not authorized to decide approval ${id}.`
        );
      }

      this.runtime.connection.prepare(`
        INSERT INTO approval_votes (approval_id, actor, decision, channel, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        decision.decidedBy,
        decision.decision,
        decision.channel ?? "api",
        decision.note ?? null,
        now
      );

      const approvalCount = Number((this.runtime.connection.prepare(`
        SELECT COUNT(*) AS count FROM approval_votes
        WHERE approval_id = ? AND decision = 'approve'
      `).get(id) as { count: number }).count);
      const finalized = decision.decision === "reject" || approvalCount >= current.requiredApprovals;
      const status: ApprovalStatus = decision.decision === "reject"
        ? "rejected"
        : finalized
          ? "approved"
          : "pending";

      const result = this.runtime.connection.prepare(`
        UPDATE approval_requests
        SET status = ?, version = version + 1, updated_at = ?,
            decided_at = ?, decided_by = ?, decision_note = ?
        WHERE id = ? AND status = 'pending' AND version = ?
      `).run(
        status,
        now,
        finalized ? now : null,
        finalized ? decision.decidedBy : null,
        finalized ? decision.note ?? null : null,
        id,
        decision.expectedVersion
      );
      if (result.changes !== 1) {
        throw new ApprovalConflictError(`Approval ${id} changed before the decision was recorded.`);
      }
      this.runtime.connection.exec("COMMIT");
    } catch (error) {
      this.runtime.connection.exec("ROLLBACK");
      if (
        error instanceof Error
        && error.message.includes("UNIQUE constraint failed: approval_votes.approval_id, approval_votes.actor")
      ) {
        throw new ApprovalConflictError(`${decision.decidedBy} has already voted on approval ${id}.`);
      }
      throw error;
    }
    return this.getWithoutExpiry(id)!;
  }

  reconcile(
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
    note?: string
  ): ApprovalRequest | null {
    const current = this.get(id);
    if (!current || current.status !== "pending") return current;
    const now = new Date().toISOString();
    this.runtime.connection.prepare(`
      UPDATE approval_requests
      SET status = ?, version = version + 1, decided_at = ?, decided_by = 'runtime-recovery',
          decision_note = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND version = ?
    `).run(status, now, note ?? null, now, id, current.version);
    return this.getWithoutExpiry(id);
  }

  expireDue(now = new Date()): ApprovalRequest[] {
    const iso = now.toISOString();
    const rows = this.runtime.connection.prepare(`
      SELECT * FROM approval_requests
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).all(iso) as unknown as ApprovalRow[];
    if (!rows.length) return [];
    this.runtime.connection.prepare(`
      UPDATE approval_requests
      SET status = 'expired', version = version + 1, updated_at = ?,
          decided_at = ?, decided_by = 'runtime-expiry',
          decision_note = 'Approval expired before quorum was reached.'
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(iso, iso, iso);
    return rows.map((row) => this.getWithoutExpiry(row.id)!).filter(Boolean);
  }

  markNotified(id: string): ApprovalRequest | null {
    const now = new Date().toISOString();
    this.runtime.connection.prepare(`
      UPDATE approval_requests
      SET notified_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
    return this.getWithoutExpiry(id);
  }

  telegramToken(id: string): string | null {
    const row = this.runtime.connection.prepare(
      "SELECT telegram_token FROM approval_requests WHERE id = ?"
    ).get(id) as { telegram_token: string | null } | undefined;
    return row?.telegram_token ?? null;
  }

  claimExecution(id: string, payloadHash: string, claimedBy: string): ApprovalExecution {
    const approval = this.get(id);
    if (!approval) throw new Error(`Approval not found: ${id}`);
    if (approval.status !== "approved") {
      throw new ApprovalConflictError(`Approval ${id} is ${approval.status}, not approved.`);
    }
    if (!approval.action || !approval.payloadHash) {
      throw new Error(`Approval ${id} does not contain an executable action.`);
    }
    if (!constantTimeEqual(approval.payloadHash, payloadHash)) {
      throw new ApprovalAuthorizationError(`Approval payload hash mismatch for ${id}.`);
    }

    const execution: ApprovalExecution = {
      id: `execution-${crypto.randomUUID()}`,
      approvalId: id,
      payloadHash,
      status: "claimed",
      claimedBy,
      claimedAt: new Date().toISOString()
    };
    try {
      this.runtime.connection.prepare(`
        INSERT INTO approval_executions (
          id, approval_id, payload_hash, status, claimed_by, claimed_at
        ) VALUES (?, ?, ?, 'claimed', ?, ?)
      `).run(
        execution.id,
        execution.approvalId,
        execution.payloadHash,
        execution.claimedBy,
        execution.claimedAt
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new ApprovalConflictError(`Approval ${id} has already been claimed for execution.`);
      }
      throw error;
    }
    return execution;
  }

  getExecutionByApproval(id: string): ApprovalExecution | null {
    const row = this.runtime.connection.prepare(
      "SELECT * FROM approval_executions WHERE approval_id = ?"
    ).get(id) as ExecutionRow | undefined;
    return row ? this.executionFromRow(row) : null;
  }

  completeExecution(input: CompleteApprovalExecutionInput): ApprovalExecution {
    const now = new Date().toISOString();
    const result = this.runtime.connection.prepare(`
      UPDATE approval_executions
      SET status = ?, completed_at = ?, result_json = ?
      WHERE id = ? AND status = 'claimed'
    `).run(
      input.status,
      now,
      input.result ? JSON.stringify(input.result) : null,
      input.executionId
    );
    if (result.changes !== 1) {
      throw new ApprovalConflictError(`Execution ${input.executionId} is not claimable.`);
    }
    const row = this.runtime.connection.prepare(
      "SELECT * FROM approval_executions WHERE id = ?"
    ).get(input.executionId) as unknown as ExecutionRow;
    return this.executionFromRow(row);
  }

  private insert(input: CreateApprovalInput & {
    kind: ApprovalKind;
    risk: ApprovalRisk;
    sourceKey?: string;
  }): ApprovalRequest {
    const now = new Date();
    const reviewers = uniqueNonEmpty(input.authorizedReviewers ?? [input.assignedTo]);
    if (!reviewers.includes(input.assignedTo)) reviewers.unshift(input.assignedTo);
    const guardedHighRisk = input.risk === "high" && Boolean(input.action);
    const requiredApprovals = input.requiredApprovals ?? (guardedHighRisk ? 2 : 1);
    if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1) {
      throw new Error("requiredApprovals must be a positive integer.");
    }
    if (requiredApprovals > reviewers.length) {
      throw new Error(
        `Approval requires ${requiredApprovals} reviewers but only ${reviewers.length} are authorized.`
      );
    }

    let expiresAt = input.expiresAt;
    if (input.expiresInMinutes !== undefined) {
      if (!Number.isFinite(input.expiresInMinutes) || input.expiresInMinutes <= 0) {
        throw new Error("expiresInMinutes must be greater than zero.");
      }
      expiresAt = new Date(now.getTime() + input.expiresInMinutes * 60_000).toISOString();
    }
    if (expiresAt) {
      const expiresAtMs = new Date(expiresAt).getTime();
      if (!Number.isFinite(expiresAtMs)) throw new Error("expiresAt must be a valid timestamp.");
      if (expiresAtMs <= now.getTime()) throw new Error("expiresAt must be in the future.");
    }

    const id = this.newId();
    const payloadHash = input.action ? approvalPayloadHash(input.action) : undefined;
    const telegramToken = crypto.randomBytes(9).toString("base64url");
    const timestamp = now.toISOString();
    this.runtime.connection.prepare(`
      INSERT INTO approval_requests (
        id, source_key, kind, title, description, requested_by, assigned_to,
        authorized_reviewers_json, risk, status, version, required_approvals,
        task_id, message_id, workflow_id, expires_at, payload_hash, action_type,
        action_payload_json, checkpoint_id, local_only, telegram_token, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sourceKey ?? null,
      input.kind,
      input.title,
      input.description ?? null,
      input.requestedBy,
      input.assignedTo,
      JSON.stringify(reviewers),
      input.risk,
      requiredApprovals,
      input.taskId ?? null,
      input.messageId ?? null,
      input.workflowId ?? null,
      expiresAt ?? null,
      payloadHash ?? null,
      input.action?.type ?? null,
      input.action ? JSON.stringify(input.action.payload) : null,
      input.checkpointId ?? null,
      input.localOnly ? 1 : 0,
      telegramToken,
      JSON.stringify(input.metadata ?? {}),
      timestamp,
      timestamp
    );
    return this.getWithoutExpiry(id)!;
  }

  private newId(): string {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `approval-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  }

  private getWithoutExpiry(id: string): ApprovalRequest | null {
    const row = this.runtime.connection.prepare(
      "SELECT * FROM approval_requests WHERE id = ?"
    ).get(id) as ApprovalRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  private fromRow(row: ApprovalRow): ApprovalRequest {
    const votes = this.runtime.connection.prepare(`
      SELECT actor, decision, channel, note, created_at
      FROM approval_votes WHERE approval_id = ? ORDER BY id ASC
    `).all(row.id) as unknown as VoteRow[];
    const authorizedReviewers = parseJson<string[]>(row.authorized_reviewers_json, [row.assigned_to]);
    const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
    const actionPayload = row.action_payload_json
      ? parseJson<Record<string, unknown>>(row.action_payload_json, {})
      : undefined;
    return {
      id: row.id,
      sourceKey: row.source_key ?? undefined,
      kind: row.kind,
      title: row.title,
      description: row.description ?? undefined,
      requestedBy: row.requested_by,
      assignedTo: row.assigned_to,
      authorizedReviewers,
      risk: row.risk,
      status: row.status,
      version: row.version,
      requiredApprovals: row.required_approvals,
      approvalCount: votes.filter((vote) => vote.decision === "approve").length,
      taskId: row.task_id ?? undefined,
      messageId: row.message_id ?? undefined,
      workflowId: row.workflow_id ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      payloadHash: row.payload_hash ?? undefined,
      action: row.action_type && actionPayload
        ? { type: row.action_type, payload: actionPayload }
        : undefined,
      checkpointId: row.checkpoint_id ?? undefined,
      localOnly: row.local_only === 1,
      votes: votes.map((vote) => ({
        actor: vote.actor,
        decision: vote.decision,
        channel: vote.channel,
        note: vote.note ?? undefined,
        createdAt: vote.created_at
      })),
      metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      decisionNote: row.decision_note ?? undefined,
      notifiedAt: row.notified_at ?? undefined
    };
  }

  private executionFromRow(row: ExecutionRow): ApprovalExecution {
    return {
      id: row.id,
      approvalId: row.approval_id,
      payloadHash: row.payload_hash,
      status: row.status,
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at ?? undefined,
      result: row.result_json
        ? parseJson<Record<string, unknown>>(row.result_json, {})
        : undefined
    };
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
