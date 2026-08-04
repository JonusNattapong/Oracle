import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RuntimeDatabase } from "../runtime/database.js";
import { ApprovalStore } from "./approvalStore.js";

let home: string;
let database: RuntimeDatabase;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-approval-store-"));
  database = new RuntimeDatabase(home);
});

afterEach(async () => {
  database.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("ApprovalStore", () => {
  test("persists approval requests and decisions in SQLite", () => {
    const store = new ApprovalStore(database);
    const approval = store.create({
      kind: "command",
      title: "Deploy release",
      requestedBy: "agent",
      assignedTo: "lead",
      risk: "high",
      metadata: { environment: "production" }
    });
    expect(store.list({ status: "pending" })).toHaveLength(1);
    expect(store.decide(approval.id, {
      decision: "approve",
      decidedBy: "lead",
      expectedVersion: approval.version,
      note: "Verified"
    })).toMatchObject({
      status: "approved",
      decidedBy: "lead",
      decisionNote: "Verified"
    });

    database.close();
    database = new RuntimeDatabase(home);
    expect(new ApprovalStore(database).get(approval.id)).toMatchObject({
      title: "Deploy release",
      status: "approved",
      metadata: { environment: "production" }
    });
  });

  test("creates one approval per task review cycle", () => {
    const store = new ApprovalStore(database);
    const first = store.ensureTaskReview({
      taskId: "task-1",
      reviewKey: "2026-07-24T01:00:00.000Z",
      title: "Review task",
      requestedBy: "worker",
      assignedTo: "lead"
    });
    const duplicate = store.ensureTaskReview({
      taskId: "task-1",
      reviewKey: "2026-07-24T01:00:00.000Z",
      title: "Review task",
      requestedBy: "worker",
      assignedTo: "lead"
    });
    store.decide(first.approval.id, {
      decision: "reject",
      decidedBy: "lead",
      expectedVersion: first.approval.version
    });
    const secondCycle = store.ensureTaskReview({
      taskId: "task-1",
      reviewKey: "2026-07-24T02:00:00.000Z",
      title: "Review task again",
      requestedBy: "worker",
      assignedTo: "lead"
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(secondCycle.created).toBe(true);
    expect(secondCycle.approval.id).not.toBe(first.approval.id);
  });

  test("enforces reviewer authorization, quorum, version locks, expiry, and execute-once claims", () => {
    const store = new ApprovalStore(database);
    const approval = store.create({
      kind: "command",
      title: "Push production release",
      requestedBy: "agent",
      assignedTo: "lead",
      authorizedReviewers: ["lead", "security"],
      requiredApprovals: 2,
      risk: "high",
      expiresInMinutes: 15,
      action: {
        type: "agent.tool",
        payload: {
          toolName: "bash",
          input: { command: "git push origin main" },
          workspaceRoot: "/workspace"
        }
      }
    });

    expect(() => store.decide(approval.id, {
      decision: "approve",
      decidedBy: "intruder",
      expectedVersion: approval.version
    })).toThrow(/not authorized/);

    const firstVote = store.decide(approval.id, {
      decision: "approve",
      decidedBy: "lead",
      expectedVersion: approval.version
    });
    expect(firstVote).toMatchObject({
      status: "pending",
      approvalCount: 1,
      requiredApprovals: 2,
      version: 2
    });
    expect(() => store.decide(approval.id, {
      decision: "approve",
      decidedBy: "security",
      expectedVersion: approval.version
    })).toThrow(/changed/);

    const approved = store.decide(approval.id, {
      decision: "approve",
      decidedBy: "security",
      expectedVersion: firstVote.version
    });
    expect(approved.status).toBe("approved");
    const execution = store.claimExecution(approval.id, approved.payloadHash!, "agent");
    expect(execution.status).toBe("claimed");
    expect(() => store.claimExecution(approval.id, approved.payloadHash!, "agent")).toThrow(/already/);
    expect(store.completeExecution({
      executionId: execution.id,
      status: "completed",
      result: { ok: true }
    })).toMatchObject({ status: "completed", result: { ok: true } });

    const expiring = store.create({
      title: "Short request",
      requestedBy: "agent",
      assignedTo: "lead",
      expiresInMinutes: 1
    });
    store.expireDue(new Date(Date.now() + 61_000));
    expect(store.get(expiring.id)?.status).toBe("expired");
  });
});
