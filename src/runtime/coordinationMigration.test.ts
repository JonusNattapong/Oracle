import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentRegistry } from "../messaging/registry.js";
import { MessageStore } from "../messaging/store.js";
import { TaskStore, type TaskRecord } from "../tasks/store.js";
import { RuntimeDatabase } from "./database.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-coordination-migration-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("SQLite coordination migration", () => {
  test("imports legacy messages, tasks, and agents without deleting source files", async () => {
    const message = {
      id: "20260724000000000-deadbeef",
      ts: "2026-07-24T00:00:00.000Z",
      from: "lead",
      to: "worker",
      body: "legacy message",
      readBy: []
    };
    const task: TaskRecord = {
      id: "20260724000000000-cafebabe",
      title: "Legacy task",
      createdBy: "lead",
      assignee: "worker",
      status: "pending",
      checklist: [],
      notes: [],
      proposals: [],
      messageIds: [],
      coordinationEvents: [],
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z"
    };
    const agent = {
      name: "worker",
      role: "tests",
      registeredAt: "2026-07-24T00:00:00.000Z",
      lastSeen: "2026-07-24T00:00:00.000Z"
    };
    await fs.mkdir(path.join(home, "messages"), { recursive: true });
    await fs.mkdir(path.join(home, "tasks"), { recursive: true });
    await fs.mkdir(path.join(home, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(home, "messages", `${message.id}.json`),
      JSON.stringify(message)
    );
    await fs.writeFile(
      path.join(home, "tasks", `${task.id}.json`),
      JSON.stringify(task)
    );
    await fs.writeFile(
      path.join(home, "agents", `${agent.name}.json`),
      JSON.stringify(agent)
    );

    const ms = new MessageStore(home);
    try {
      expect(await ms.inbox("worker")).toMatchObject([
        { id: message.id, body: "legacy message" }
      ]);
    } finally {
      ms.dispose();
    }
    const ts = new TaskStore(home);
    try {
      expect(await ts.get(task.id)).toMatchObject({
        id: task.id,
        title: "Legacy task"
      });
    } finally {
      ts.dispose();
    }
    const ar = new AgentRegistry(home);
    try {
      expect(await ar.get("worker")).toMatchObject({
        name: "worker",
        role: "tests"
      });
    } finally {
      ar.dispose();
    }

    const database = new RuntimeDatabase(home);
    try {
      expect(database.connection.prepare(
        "SELECT COUNT(*) AS count FROM coordination_messages"
      ).get()).toEqual({ count: 1 });
      expect(database.connection.prepare(
        "SELECT COUNT(*) AS count FROM coordination_tasks"
      ).get()).toEqual({ count: 1 });
      expect(database.connection.prepare(
        "SELECT COUNT(*) AS count FROM coordination_agents"
      ).get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }

    await expect(fs.stat(path.join(home, "messages", `${message.id}.json`))).resolves.toBeDefined();
    await expect(fs.stat(path.join(home, "tasks", `${task.id}.json`))).resolves.toBeDefined();
    await expect(fs.stat(path.join(home, "agents", `${agent.name}.json`))).resolves.toBeDefined();
  });
});
