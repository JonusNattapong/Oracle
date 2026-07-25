import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RuntimeDatabase } from "./database.js";
import { RuntimeEventBus } from "./events.js";
import { RemoteSwarmService } from "./swarmService.js";

let home: string;
let database: RuntimeDatabase;
let service: RemoteSwarmService;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-remote-swarm-"));
  database = new RuntimeDatabase(home);
  service = new RemoteSwarmService(database, new RuntimeEventBus(database));
});

afterEach(async () => {
  database.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe("RemoteSwarmService", () => {
  test("authenticates hashed project-scoped tokens and tracks presence", () => {
    const issued = service.issueToken({
      projectId: "clew-code",
      agentName: "claude-lead",
      role: "lead"
    });
    expect(issued.token).toMatch(/^oracle_swarm_/);
    const identity = service.authenticate(issued.token);
    expect(identity).toEqual({
      projectId: "clew-code",
      agentName: "claude-lead",
      role: "lead"
    });
    expect(service.authenticate("oracle_swarm_wrong")).toBeNull();

    const stored = database.connection.prepare(`
      SELECT token_hash FROM swarm_tokens WHERE id = ?
    `).get(issued.id) as { token_hash: string };
    expect(stored.token_hash).not.toContain(issued.token);

    service.connect(identity!);
    expect(service.listAgents("clew-code")).toMatchObject([
      { name: "claude-lead", status: "online", role: "lead" }
    ]);
    expect(service.revokeToken(issued.id)).toBe(true);
    expect(service.authenticate(issued.token)).toBeNull();
  });

  test("delivers and acknowledges messages without cross-project leakage", () => {
    const lead = service.authenticate(service.issueToken({
      projectId: "project-a",
      agentName: "lead"
    }).token)!;
    const worker = service.authenticate(service.issueToken({
      projectId: "project-a",
      agentName: "worker"
    }).token)!;
    const outsider = service.authenticate(service.issueToken({
      projectId: "project-b",
      agentName: "worker"
    }).token)!;

    const message = service.sendMessage(lead, {
      to: "worker",
      subject: "Review",
      body: "Please review the runtime."
    });
    expect(service.inbox(worker)).toMatchObject([{ id: message.id }]);
    expect(service.inbox(outsider)).toEqual([]);
    expect(service.acknowledge(worker, [message.id])).toEqual([message.id]);
    expect(service.acknowledge(worker, [message.id])).toEqual([]);
    expect(service.inbox(worker)).toEqual([]);
  });

  test("enforces assignee verification and creator review", () => {
    const lead = service.authenticate(service.issueToken({
      projectId: "oracle",
      agentName: "lead",
      role: "lead"
    }).token)!;
    const worker = service.authenticate(service.issueToken({
      projectId: "oracle",
      agentName: "worker"
    }).token)!;
    const task = service.createTask(lead, {
      title: "Remote tests",
      assignee: "worker",
      checklist: ["tests pass", "docs updated"]
    });

    expect(() => service.submitTask(worker, task.id, "done")).toThrow(/unchecked/);
    service.checkTask(worker, task.id, 0, true);
    service.checkTask(worker, task.id, 1, true);
    expect(service.submitTask(worker, task.id, "verified").status).toBe("review");
    expect(() => service.closeTask(worker, task.id, { approved: true })).toThrow(
      /creator/
    );
    expect(service.closeTask(lead, task.id, { approved: true }).status).toBe("done");
  });
});
