import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryAdapter } from "../memory/adapter.js";
import { AuditLogger } from "../observability/audit.js";
import { RuntimeDatabase } from "../runtime/database.js";
import { RuntimeEventBus } from "../runtime/events.js";
import { SchedulerService } from "../runtime/schedulerService.js";
import { TaskStore } from "../tasks/store.js";
import { ControlCenterService } from "./service.js";
import { TelegramApprovalNotifier } from "./telegram.js";

let home: string;
let workspace: string;
let database: RuntimeDatabase;
let service: ControlCenterService;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-control-home-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-control-workspace-"));
  database = new RuntimeDatabase(home);
  const events = new RuntimeEventBus(database);
  service = new ControlCenterService(
    database,
    events,
    new SchedulerService(database, events),
    {
      homeDir: home,
      workspaceRoot: workspace,
      telegram: new TelegramApprovalNotifier({ botToken: "", chatId: "" })
    }
  );
});

afterEach(async () => {
  service.dispose();
  database.close();
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("ControlCenterService", () => {
  test("turns task review into an approval and closes through CoordinationService", async () => {
    const tasks = new TaskStore(home);
    const task = await tasks.create({
      title: "Implement dashboard",
      createdBy: "lead",
      assignee: "worker"
    });
    await tasks.submitForReview(task.id, "worker", "Dashboard complete");

    const snapshot = await service.snapshot();
    expect(snapshot.approvals.items).toHaveLength(1);
    expect(snapshot.approvals.items[0]).toMatchObject({
      kind: "task_review",
      taskId: task.id,
      assignedTo: "lead"
    });

    const decided = await service.decide(snapshot.approvals.items[0].id, {
      decision: "approve",
      decidedBy: "lead",
      expectedVersion: snapshot.approvals.items[0].version,
      note: "Looks good"
    });
    expect(decided.status).toBe("approved");
    expect(await tasks.get(task.id)).toMatchObject({ status: "done" });

    const audits = await new AuditLogger().readRecords(workspace);
    expect(audits.some((record) =>
      record.target === `approval:${decided.id}`
      && record.details?.controlCenterAction === "approve"
    )).toBe(true);
  });

  test("aggregates task, memory, and audit visualization without touching memory", async () => {
    await new MemoryAdapter(workspace).remember(
      "worker",
      "insight",
      "Control Center uses a blue monitoring theme."
    );
    await new AuditLogger().log(workspace, {
      action: "policy_denied",
      target: ".env",
      agentId: "worker"
    });
    await new TaskStore(home).create({
      title: "Visualize memory",
      createdBy: "lead",
      assignee: "worker"
    });

    const snapshot = await service.snapshot();
    expect(snapshot.tasks).toMatchObject({ total: 1, active: 1 });
    expect(snapshot.memory.project.byType.insight).toBe(1);
    expect(snapshot.memory.project.recent[0].accessCount).toBe(0);
    expect(snapshot.audit.policyDenials).toBe(1);
  });

  test("sends optional Telegram notification without making it a dependency", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const events = new RuntimeEventBus(database);
    const telegramService = new ControlCenterService(
      database,
      events,
      new SchedulerService(database, events),
      {
        homeDir: home,
        workspaceRoot: workspace,
        telegram: new TelegramApprovalNotifier({
          botToken: "test-bot-token",
          chatId: "123",
          fetchImpl
        })
      }
    );
    const approval = await telegramService.createApproval({
      title: "Approve release",
      requestedBy: "worker",
      assignedTo: "lead",
      risk: "high"
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(telegramService.getApproval(approval.id)?.notifiedAt).toBeDefined();
  });
});
