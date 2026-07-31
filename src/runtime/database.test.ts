import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RuntimeDatabase, SqliteCronTaskStore } from "./database.js";
import { CompanionStore } from "../companion/store.js";

let home: string;
let database: RuntimeDatabase;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-runtime-db-"));
  database = new RuntimeDatabase(home);
});

afterEach(async () => {
  database.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe("RuntimeDatabase", () => {
  test("creates the SQLite file with owner-only permissions", async () => {
    const stat = await fs.stat(database.filePath);
    if (os.platform() !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(database.connection.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'schema_version'"
    ).get()).toEqual({ value: "10" });
  });

  test("persists scheduler tasks and run history in SQLite", async () => {
    const store = new SqliteCronTaskStore(database);
    const task = await store.create({
      name: "runtime test",
      cron: "*/5 * * * *",
      command: "echo ok"
    });
    await store.recordRun(task.id, "success", "ok");
    database.close();

    database = new RuntimeDatabase(home);
    const reloaded = await new SqliteCronTaskStore(database).get(task.id);
    expect(reloaded).toMatchObject({
      id: task.id,
      name: "runtime test",
      lastResult: "success",
      lastOutput: "ok"
    });

    const runs = database.connection.prepare(
      "SELECT task_id, result, output FROM scheduler_runs WHERE task_id = ?"
    ).all(task.id);
    expect(runs).toEqual([{ task_id: task.id, result: "success", output: "ok" }]);
  });

  test("imports legacy scheduler JSON idempotently", async () => {
    const legacyDir = path.join(home, "scheduler");
    await fs.mkdir(legacyDir, { recursive: true });
    const legacy = {
      id: "legacy-task-1",
      name: "legacy",
      cron: "0 2 * * *",
      command: "echo legacy",
      status: "active",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z"
    };
    await fs.writeFile(
      path.join(legacyDir, `${legacy.id}.json`),
      JSON.stringify(legacy),
      "utf8"
    );

    const store = new SqliteCronTaskStore(database);
    expect(await store.importLegacyDirectory(home)).toBe(1);
    expect(await store.importLegacyDirectory(home)).toBe(0);
    expect(await store.get(legacy.id)).toMatchObject({ name: "legacy" });
  });

  test("stores replayable runtime events in order", () => {
    const first = database.recordEvent("daemon.started", { pid: 123 });
    const second = database.recordEvent("scheduler.started", { activeTasks: 2 });

    expect(database.listEvents(first.id)).toEqual([second]);
    expect(database.listEvents(0).map((event) => event.type)).toEqual([
      "daemon.started",
      "scheduler.started"
    ]);
  });

  test("persists sandbox execution evidence", () => {
    database.recordSandboxRun({
      id: "sandbox-test",
      mode: "docker",
      command: "npm test",
      commandHash: "abc123",
      workspaceRoot: "C:/workspace",
      network: "none",
      image: "node:24-bookworm-slim",
      exitCode: 0,
      durationMs: 42,
      killed: false,
      createdAt: "2026-07-30T00:00:00.000Z"
    });
    expect(database.connection.prepare(`
      SELECT mode, command_hash, workspace_root, network, image, exit_code, duration_ms
      FROM sandbox_runs WHERE id = 'sandbox-test'
    `).get()).toEqual({
      mode: "docker",
      command_hash: "abc123",
      workspace_root: "C:/workspace",
      network: "none",
      image: "node:24-bookworm-slim",
      exit_code: 0,
      duration_ms: 42
    });
  });

  test("migrates a 0.2 approval database without losing pending requests", async () => {
    database.close();
    await fs.rm(home, { recursive: true, force: true });
    await fs.mkdir(path.join(home, "runtime"), { recursive: true });
    const file = path.join(home, "runtime", "oracle.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO runtime_metadata VALUES ('schema_version', '2', '2026-01-01T00:00:00.000Z');
      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        source_key TEXT UNIQUE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        requested_by TEXT NOT NULL,
        assigned_to TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        message_id TEXT,
        workflow_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_note TEXT,
        notified_at TEXT
      ) STRICT;
      INSERT INTO approval_requests (
        id, kind, title, requested_by, assigned_to, risk, status,
        metadata_json, created_at, updated_at
      ) VALUES (
        'approval-legacy', 'custom', 'Legacy request', 'worker', 'lead',
        'medium', 'pending', '{}', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    database = new RuntimeDatabase(home);
    expect(database.connection.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'schema_version'"
    ).get()).toEqual({ value: "10" });
    expect(database.connection.prepare(`
      SELECT status, version, required_approvals, authorized_reviewers_json
      FROM approval_requests WHERE id = 'approval-legacy'
    `).get()).toEqual({
      status: "pending",
      version: 1,
      required_approvals: 1,
      authorized_reviewers_json: "[\"lead\"]"
    });
  });

  test("migrates a schema 9 database and makes Companion storage usable", async () => {
    database.close();
    await fs.rm(home, { recursive: true, force: true });
    await fs.mkdir(path.join(home, "runtime"), { recursive: true });
    const file = path.join(home, "runtime", "oracle.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO runtime_metadata VALUES (
        'schema_version',
        '9',
        '2026-07-30T00:00:00.000Z'
      );
    `);
    legacy.close();

    database = new RuntimeDatabase(home);
    expect(database.connection.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'schema_version'"
    ).get()).toEqual({ value: "10" });

    const store = new CompanionStore(database);
    const presence = store.createPresence({
      state: "home",
      source: "manual",
      confidence: 1,
      observedAt: "2026-07-31T00:00:00.000Z",
      expiresAt: "2026-07-31T02:00:00.000Z",
      createdAt: "2026-07-31T00:00:00.000Z"
    });
    expect(store.latestPresence()).toEqual(presence);
  });
});
