import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { RuntimeClient } from "./client.js";
import { OracleDaemon } from "./daemon.js";
import { readDaemonState } from "./state.js";
import { SwarmClient } from "./swarmClient.js";

let home: string;
let daemon: OracleDaemon | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-daemon-"));
});

afterEach(async () => {
  await daemon?.stop();
  await fs.rm(home, { recursive: true, force: true });
});

describe("OracleDaemon", () => {
  test("serves scheduler API from SQLite and removes state on stop", async () => {
    daemon = new OracleDaemon({
      homeDir: home,
      workspaceRoot: home,
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const state = await daemon.start();
    const stateStat = await fs.stat(path.join(home, "runtime", "daemon.json"));
    if (os.platform() !== "win32") {
      expect(stateStat.mode & 0o777).toBe(0o600);
    }
    const client = await RuntimeClient.connect(home);
    expect(client).not.toBeNull();
    const unauthorized = await fetch(`http://${state.host}:${state.port}/v1/schedules`);
    expect(unauthorized.status).toBe(401);
    const controlPage = await fetch(`http://${state.host}:${state.port}/control`);
    expect(controlPage.status).toBe(200);
    expect(await controlPage.text()).toContain("Oracle Control Center");
    const unauthorizedControl = await fetch(`http://${state.host}:${state.port}/v1/control/snapshot`);
    expect(unauthorizedControl.status).toBe(401);
    expect(await client!.health()).toMatchObject({
      status: "ok",
      schedulerRunning: true,
      storage: "sqlite"
    });
    expect(await client!.getControlSnapshot()).toMatchObject({
      version: "0.7.0",
      workspaceRoot: home,
      approvals: { pending: 0 }
    });

    const leadToken = await client!.issueSwarmToken({
      projectId: "runtime-test",
      agentName: "lead",
      role: "lead"
    });
    const workerToken = await client!.issueSwarmToken({
      projectId: "runtime-test",
      agentName: "worker",
      role: "worker"
    });
    const runtimeUrl = `http://${state.host}:${state.port}`;
    const lead = new SwarmClient({
      url: runtimeUrl,
      projectId: "runtime-test",
      agentName: "lead",
      token: leadToken.token,
      connectedAt: new Date().toISOString()
    });
    const worker = new SwarmClient({
      url: runtimeUrl,
      projectId: "runtime-test",
      agentName: "worker",
      token: workerToken.token,
      connectedAt: new Date().toISOString()
    });
    await lead.connect();
    await worker.connect();
    const remoteMessage = await lead.send({ to: "worker", body: "remote hello" });
    expect(await worker.inbox()).toMatchObject([{ id: remoteMessage.id }]);
    expect(await worker.acknowledge([remoteMessage.id])).toEqual([remoteMessage.id]);
    const remoteTask = await lead.createTask({
      title: "Verify Runtime",
      assignee: "worker",
      checklist: ["smoke passes"]
    });
    await worker.checkTask(remoteTask.id, 0, true);
    expect((await worker.submitTask(remoteTask.id, "passed")).status).toBe("review");
    expect((await lead.closeTask(remoteTask.id, true)).status).toBe("done");

    const approval = await client!.createApproval({
      title: "Runtime approval",
      requestedBy: "worker",
      assignedTo: "lead",
      risk: "low"
    });
    expect(await client!.listApprovals("pending")).toHaveLength(1);
    expect(await client!.decideApproval(approval.id, {
      decision: "approve",
      decidedBy: "lead",
      expectedVersion: approval.version
    })).toMatchObject({ status: "approved" });

    const task = await client!.createSchedule({
      name: "API task",
      cron: "*/5 * * * *",
      command: "node -e \"process.stdout.write('runtime-ok')\""
    });
    expect(await client!.listSchedules()).toHaveLength(1);
    expect((await client!.runSchedule(task.id)).output).toBe("runtime-ok");

    const failing = await client!.createSchedule({
      name: "failing API task",
      cron: "*/5 * * * *",
      command: "node -e \"process.exit(3)\""
    });
    expect(await client!.runSchedule(failing.id)).toMatchObject({ result: "error" });
    expect(await fs.stat(state.databasePath)).toBeDefined();

    await daemon.stop();
    expect(await readDaemonState(home)).toBeNull();
  });

  test("streams persisted scheduler events over WebSocket", async () => {
    daemon = new OracleDaemon({
      homeDir: home,
      workspaceRoot: home,
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    await daemon.start();
    const client = (await RuntimeClient.connect(home))!;
    const socket = new WebSocket(client.webSocketUrl());
    const seen = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as { type?: string; payload?: Record<string, unknown> };
        if (event.type === "scheduler.task.created") resolve(event.payload ?? {});
      });
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const task = await client.createSchedule({
      name: "WebSocket task",
      cron: "*/10 * * * *",
      command: "echo websocket"
    });
    await expect(seen).resolves.toMatchObject({ task: { id: task.id } });
    socket.close();
  });

  test("filters Remote Swarm WebSocket events by token project", async () => {
    daemon = new OracleDaemon({
      homeDir: home,
      workspaceRoot: home,
      host: "127.0.0.1",
      port: 0,
      token: "test-token"
    });
    const state = await daemon.start();
    const runtime = (await RuntimeClient.connect(home))!;
    const tokenA = await runtime.issueSwarmToken({
      projectId: "project-a",
      agentName: "lead-a"
    });
    const tokenB = await runtime.issueSwarmToken({
      projectId: "project-b",
      agentName: "lead-b"
    });
    const makeClient = (projectId: string, agentName: string, token: string) =>
      new SwarmClient({
        url: `http://${state.host}:${state.port}`,
        projectId,
        agentName,
        token,
        connectedAt: new Date().toISOString()
      });
    const clientA = makeClient("project-a", "lead-a", tokenA.token);
    const clientB = makeClient("project-b", "lead-b", tokenB.token);
    await clientA.connect();
    await clientB.connect();

    const socket = new WebSocket(clientA.webSocketUrl(), {
      headers: clientA.webSocketHeaders()
    });
    let leaked = false;
    const seen = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as {
          type?: string;
          payload?: Record<string, unknown>;
        };
        if (event.payload?.projectId === "project-b") leaked = true;
        if (
          event.type === "swarm.message.created"
          && event.payload?.projectId === "project-a"
        ) resolve(event.payload);
      });
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    await clientB.send({ to: "*", body: "must not leak" });
    const messageA = await clientA.send({ to: "*", body: "project a event" });
    await expect(seen).resolves.toMatchObject({
      projectId: "project-a",
      message: { id: messageA.id }
    });
    expect(leaked).toBe(false);
    socket.close();
  });

  test("rejects non-loopback API binding", async () => {
    daemon = new OracleDaemon({ homeDir: home, host: "0.0.0.0", port: 0 });
    await expect(daemon.start()).rejects.toThrow(/loopback/);
  });

  test("allows an explicit authenticated Remote Swarm binding", async () => {
    daemon = new OracleDaemon({
      homeDir: home,
      workspaceRoot: home,
      host: "0.0.0.0",
      port: 0,
      token: "admin-token",
      allowRemote: true
    });
    const state = await daemon.start();
    expect(state.host).toBe("0.0.0.0");
  });
});
