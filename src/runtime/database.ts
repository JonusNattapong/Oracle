import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CreateTaskInput,
  CronTask,
  CronTaskRepository,
  CronTaskStatus,
  UpdateTaskInput
} from "../scheduler/taskStore.js";
import type { SandboxRunRecord } from "../sandbox/runner.js";

export interface RuntimeEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface CronTaskRow {
  id: string;
  name: string;
  cron: string;
  command: string;
  description: string | null;
  status: CronTaskStatus;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_result: "success" | "error" | null;
  last_output: string | null;
}

interface RuntimeEventRow {
  id: number;
  type: string;
  payload_json: string;
  created_at: string;
}

export class RuntimeDatabase {
  readonly filePath: string;
  readonly connection: DatabaseSync;

  constructor(homeDir: string, filePath = path.join(homeDir, "runtime", "oracle.db")) {
    this.filePath = filePath;
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    this.connection = new DatabaseSync(filePath, { timeout: 5000 });
    fsSync.chmodSync(filePath, 0o600);
    this.migrate();
  }

  close(): void {
    try {
      this.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // checkpoint may fail if already closed; ignore
    }
    this.connection.close();
  }

  recordEvent(type: string, payload: Record<string, unknown>): RuntimeEvent {
    const createdAt = new Date().toISOString();
    const result = this.connection.prepare(
      "INSERT INTO runtime_events (type, payload_json, created_at) VALUES (?, ?, ?)"
    ).run(type, JSON.stringify(payload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      type,
      payload,
      createdAt
    };
  }

  recordSandboxRun(record: SandboxRunRecord): void {
    this.connection.prepare(`
      INSERT INTO sandbox_runs (
        id, mode, command, command_hash, workspace_root, network, image,
        exit_code, duration_ms, killed, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.mode,
      record.command,
      record.commandHash,
      record.workspaceRoot,
      record.network,
      record.image ?? null,
      record.exitCode,
      record.durationMs,
      record.killed ? 1 : 0,
      record.error ?? null,
      record.createdAt
    );
  }

  listEvents(afterId = 0, limit = 100): RuntimeEvent[] {
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const rows = this.connection.prepare(
      "SELECT id, type, payload_json, created_at FROM runtime_events WHERE id > ? ORDER BY id ASC LIMIT ?"
    ).all(afterId, safeLimit) as unknown as RuntimeEventRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  private migrate(): void {
    this.connection.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);

    const row = this.connection.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'schema_version'"
    ).get() as { value: string } | undefined;
    let version = Number(row?.value ?? 0);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`Invalid Runtime database schema version: ${row?.value}`);
    }

    if (version < 1) {
      this.applyMigration(1, `
      CREATE TABLE IF NOT EXISTS scheduler_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        command TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        last_result TEXT CHECK (last_result IN ('success', 'error')),
        last_output TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS scheduler_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES scheduler_tasks(id) ON DELETE CASCADE,
        result TEXT NOT NULL CHECK (result IN ('success', 'error')),
        output TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS scheduler_tasks_status_idx
        ON scheduler_tasks(status);
      CREATE INDEX IF NOT EXISTS scheduler_runs_task_idx
        ON scheduler_runs(task_id, id DESC);

      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      `);
      version = 1;
    }

    if (version < 2) {
      this.applyMigration(2, `
      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        source_key TEXT UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('task_review', 'command', 'policy', 'custom')),
        title TEXT NOT NULL,
        description TEXT,
        requested_by TEXT NOT NULL,
        assigned_to TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
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

      CREATE INDEX IF NOT EXISTS approval_requests_status_idx
        ON approval_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS approval_requests_task_idx
        ON approval_requests(task_id);
      `);
      version = 2;
    }

    if (version < 3) {
      this.applyMigration(3, `
        ALTER TABLE approval_requests RENAME TO approval_requests_v2;

        CREATE TABLE approval_requests (
          id TEXT PRIMARY KEY,
          source_key TEXT UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('task_review', 'command', 'policy', 'custom')),
          title TEXT NOT NULL,
          description TEXT,
          requested_by TEXT NOT NULL,
          assigned_to TEXT NOT NULL,
          authorized_reviewers_json TEXT NOT NULL DEFAULT '[]',
          risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          required_approvals INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals > 0),
          task_id TEXT,
          message_id TEXT,
          workflow_id TEXT,
          expires_at TEXT,
          payload_hash TEXT,
          action_type TEXT,
          action_payload_json TEXT,
          checkpoint_id TEXT,
          local_only INTEGER NOT NULL DEFAULT 0 CHECK (local_only IN (0, 1)),
          telegram_token TEXT UNIQUE,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          decided_at TEXT,
          decided_by TEXT,
          decision_note TEXT,
          notified_at TEXT
        ) STRICT;

        INSERT INTO approval_requests (
          id, source_key, kind, title, description, requested_by, assigned_to,
          authorized_reviewers_json, risk, status, version, required_approvals,
          task_id, message_id, workflow_id, local_only, metadata_json, created_at,
          updated_at, decided_at, decided_by, decision_note, notified_at
        )
        SELECT
          id, source_key, kind, title, description, requested_by, assigned_to,
          json_array(assigned_to), risk, status, 1, 1,
          task_id, message_id, workflow_id, 0, metadata_json, created_at,
          updated_at, decided_at, decided_by, decision_note, notified_at
        FROM approval_requests_v2;

        DROP TABLE approval_requests_v2;

        CREATE INDEX approval_requests_status_idx
          ON approval_requests(status, created_at DESC);
        CREATE INDEX approval_requests_task_idx
          ON approval_requests(task_id);
        CREATE INDEX approval_requests_expiry_idx
          ON approval_requests(status, expires_at);
        CREATE INDEX approval_requests_checkpoint_idx
          ON approval_requests(checkpoint_id);

        CREATE TABLE approval_votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          approval_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
          actor TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
          channel TEXT NOT NULL CHECK (channel IN ('api', 'cli', 'tui', 'dashboard', 'telegram', 'recovery')),
          note TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (approval_id, actor)
        ) STRICT;

        CREATE INDEX approval_votes_approval_idx
          ON approval_votes(approval_id, id ASC);

        CREATE TABLE approval_executions (
          id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id) ON DELETE CASCADE,
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed')),
          claimed_by TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          completed_at TEXT,
          result_json TEXT
        ) STRICT;
      `);
      version = 3;
    }

    if (version < 4) {
      this.applyMigration(4, `
        CREATE TABLE swarm_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE swarm_tokens (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES swarm_projects(id) ON DELETE CASCADE,
          agent_name TEXT NOT NULL,
          role TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        ) STRICT;

        CREATE INDEX swarm_tokens_agent_idx
          ON swarm_tokens(project_id, agent_name, revoked_at);

        CREATE TABLE swarm_agents (
          project_id TEXT NOT NULL REFERENCES swarm_projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          connected_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (project_id, name)
        ) STRICT;

        CREATE INDEX swarm_agents_seen_idx
          ON swarm_agents(project_id, last_seen_at DESC);

        CREATE TABLE swarm_messages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES swarm_projects(id) ON DELETE CASCADE,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          subject TEXT,
          body TEXT NOT NULL,
          reply_to TEXT,
          task_id TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX swarm_messages_inbox_idx
          ON swarm_messages(project_id, to_agent, created_at ASC);
        CREATE INDEX swarm_messages_task_idx
          ON swarm_messages(project_id, task_id, created_at ASC);

        CREATE TABLE swarm_message_reads (
          message_id TEXT NOT NULL REFERENCES swarm_messages(id) ON DELETE CASCADE,
          agent_name TEXT NOT NULL,
          read_at TEXT NOT NULL,
          PRIMARY KEY (message_id, agent_name)
        ) STRICT;

        CREATE TABLE swarm_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES swarm_projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          created_by TEXT NOT NULL,
          assignee TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'in_progress', 'review', 'done', 'blocked', 'cancelled')
          ),
          checklist_json TEXT NOT NULL DEFAULT '[]',
          notes_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX swarm_tasks_assignee_idx
          ON swarm_tasks(project_id, assignee, status, updated_at DESC);
        CREATE INDEX swarm_tasks_creator_idx
          ON swarm_tasks(project_id, created_by, status, updated_at DESC);
      `);
      version = 4;
    }

    if (version < 5) {
      this.applyMigration(5, `
        CREATE TABLE coordination_messages (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          subject TEXT,
          body TEXT NOT NULL,
          reply_to TEXT,
          task_id TEXT,
          workflow_id TEXT,
          coordination_event_id TEXT,
          dead_lettered_at TEXT
        ) STRICT;

        CREATE UNIQUE INDEX coordination_messages_event_idx
          ON coordination_messages(coordination_event_id)
          WHERE coordination_event_id IS NOT NULL;
        CREATE INDEX coordination_messages_inbox_idx
          ON coordination_messages(to_agent, ts ASC);
        CREATE INDEX coordination_messages_task_idx
          ON coordination_messages(task_id, ts ASC);

        CREATE TABLE coordination_message_reads (
          message_id TEXT NOT NULL REFERENCES coordination_messages(id) ON DELETE CASCADE,
          agent_name TEXT NOT NULL,
          read_at TEXT NOT NULL,
          PRIMARY KEY (message_id, agent_name)
        ) STRICT;

        CREATE TABLE coordination_tasks (
          id TEXT PRIMARY KEY,
          record_json TEXT NOT NULL,
          status TEXT NOT NULL,
          assignee TEXT NOT NULL,
          created_by TEXT NOT NULL,
          workflow_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX coordination_tasks_assignee_idx
          ON coordination_tasks(assignee, status, updated_at DESC);
        CREATE INDEX coordination_tasks_creator_idx
          ON coordination_tasks(created_by, status, updated_at DESC);
        CREATE INDEX coordination_tasks_workflow_idx
          ON coordination_tasks(workflow_id, updated_at ASC);

        CREATE TABLE coordination_agents (
          name TEXT PRIMARY KEY,
          role TEXT,
          registered_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX coordination_agents_seen_idx
          ON coordination_agents(last_seen_at DESC);
      `);
      version = 5;
    }

    if (version < 6) {
      this.applyMigration(6, `
        CREATE TABLE coordination_workflows (
          id TEXT PRIMARY KEY,
          record_json TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX coordination_workflows_status_idx
          ON coordination_workflows(status, updated_at DESC);
      `);
      version = 6;
    }

    if (version < 7) {
      this.applyMigration(7, `
        CREATE TABLE memory_embeddings (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL UNIQUE,
          vector BLOB NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX memory_embeddings_memory_idx
          ON memory_embeddings(memory_id);

        CREATE TABLE memory_content_fts (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL
        ) STRICT;

        CREATE VIRTUAL TABLE memory_content_search USING fts5(
          content,
          memory_id UNINDEXED
        );

        CREATE TABLE memory_search_cache (
          query_hash TEXT PRIMARY KEY,
          results_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX memory_search_cache_expiry_idx
          ON memory_search_cache(expires_at);
      `);
      version = 7;
    }

    if (version < 8) {
      this.applyMigration(8, `
        CREATE TABLE cost_log (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          agent TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX cost_log_created_idx ON cost_log(created_at DESC);
        CREATE INDEX cost_log_agent_idx ON cost_log(agent, created_at DESC);
        CREATE INDEX cost_log_provider_idx ON cost_log(provider, created_at DESC);

        CREATE TABLE sandbox_runs (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL CHECK (mode IN ('docker', 'namespace', 'none')),
          command TEXT NOT NULL,
          exit_code INTEGER,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          killed INTEGER NOT NULL DEFAULT 0 CHECK (killed IN (0, 1)),
          error TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX sandbox_runs_created_idx ON sandbox_runs(created_at DESC);
      `);
      version = 8;
    }

    if (version < 9) {
      this.applyMigration(9, `
        ALTER TABLE sandbox_runs ADD COLUMN command_hash TEXT;
        ALTER TABLE sandbox_runs ADD COLUMN workspace_root TEXT NOT NULL DEFAULT '';
        ALTER TABLE sandbox_runs ADD COLUMN network TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE sandbox_runs ADD COLUMN image TEXT;
        CREATE INDEX sandbox_runs_workspace_created_idx
          ON sandbox_runs(workspace_root, created_at DESC);
      `);
      version = 9;
    }

    if (version < 10) {
      this.applyMigration(10, `
        CREATE TABLE companion_presence (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (
            state IN ('home', 'work', 'transit', 'focus', 'available', 'away', 'unknown')
          ),
          source TEXT NOT NULL CHECK (
            source IN ('manual', 'device', 'calendar', 'geofence')
          ),
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          observed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX companion_presence_observed_idx
          ON companion_presence(observed_at DESC, created_at DESC);

        CREATE TABLE companion_intents (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          presence_id TEXT,
          trigger TEXT NOT NULL CHECK (trigger IN ('presence_update', 'manual')),
          candidate TEXT NOT NULL CHECK (
            candidate IN ('welcome_home', 'check_in', 'open_conversation', 'stay_silent')
          ),
          action TEXT NOT NULL CHECK (action IN ('speak', 'silence')),
          message TEXT,
          reason TEXT NOT NULL,
          score_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX companion_intents_created_idx
          ON companion_intents(created_at DESC);

        CREATE TABLE companion_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
      version = 10;
    }

    if (version > 10) {
      throw new Error(`Runtime database schema ${version} is newer than supported schema 10.`);
    }
  }

  private applyMigration(version: number, sql: string): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.exec(sql);
      this.connection.prepare(`
        INSERT INTO runtime_metadata (key, value, updated_at)
        VALUES ('schema_version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `).run(String(version), new Date().toISOString());
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
}

export class SqliteCronTaskStore implements CronTaskRepository {
  constructor(private readonly runtime: RuntimeDatabase) {}

  async create(input: CreateTaskInput): Promise<CronTask> {
    const now = new Date().toISOString();
    const task: CronTask = {
      id: this.newId(),
      name: input.name,
      cron: input.cron,
      command: input.command,
      description: input.description,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.insert(task, false);
    return task;
  }

  async get(id: string): Promise<CronTask | null> {
    const row = this.runtime.connection.prepare(
      "SELECT * FROM scheduler_tasks WHERE id = ?"
    ).get(id) as CronTaskRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  async list(): Promise<CronTask[]> {
    const rows = this.runtime.connection.prepare(
      "SELECT * FROM scheduler_tasks WHERE status != 'deleted' ORDER BY created_at ASC"
    ).all() as unknown as CronTaskRow[];
    return rows.map((row) => this.fromRow(row));
  }

  async update(id: string, input: UpdateTaskInput): Promise<CronTask | null> {
    const current = await this.get(id);
    if (!current) return null;
    const updated: CronTask = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString()
    };
    this.runtime.connection.prepare(`
      UPDATE scheduler_tasks
      SET name = ?, cron = ?, command = ?, description = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.name,
      updated.cron,
      updated.command,
      updated.description ?? null,
      updated.status,
      updated.updatedAt,
      id
    );
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.runtime.connection.prepare(
      "DELETE FROM scheduler_tasks WHERE id = ?"
    ).run(id);
    return result.changes > 0;
  }

  async recordRun(id: string, result: "success" | "error", output: string): Promise<void> {
    const now = new Date().toISOString();
    const truncated = output.slice(0, 4000);
    this.runtime.connection.exec("BEGIN IMMEDIATE");
    try {
      this.runtime.connection.prepare(`
        UPDATE scheduler_tasks
        SET last_run_at = ?, last_result = ?, last_output = ?, updated_at = ?
        WHERE id = ?
      `).run(now, result, truncated, now, id);
      this.runtime.connection.prepare(`
        INSERT INTO scheduler_runs (task_id, result, output, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, result, truncated, now, now);
      this.runtime.connection.exec("COMMIT");
    } catch (error) {
      this.runtime.connection.exec("ROLLBACK");
      throw error;
    }
  }

  async importLegacyDirectory(homeDir: string): Promise<number> {
    const directory = path.join(homeDir, "scheduler");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      return 0;
    }

    let imported = 0;
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      try {
        const task = JSON.parse(
          await fs.readFile(path.join(directory, name), "utf8")
        ) as CronTask;
        if (this.insert(task, true)) imported++;
      } catch {
        // A malformed legacy file must not prevent the daemon from starting.
      }
    }
    return imported;
  }

  private insert(task: CronTask, ignoreExisting: boolean): boolean {
    const result = this.runtime.connection.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO scheduler_tasks (
        id, name, cron, command, description, status, created_at, updated_at,
        last_run_at, last_result, last_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.name,
      task.cron,
      task.command,
      task.description ?? null,
      task.status,
      task.createdAt,
      task.updatedAt,
      task.lastRunAt ?? null,
      task.lastResult ?? null,
      task.lastOutput ?? null
    );
    return result.changes > 0;
  }

  private fromRow(row: CronTaskRow): CronTask {
    return {
      id: row.id,
      name: row.name,
      cron: row.cron,
      command: row.command,
      description: row.description ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: row.last_run_at ?? undefined,
      lastResult: row.last_result ?? undefined,
      lastOutput: row.last_output ?? undefined
    };
  }

  private newId(): string {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  }
}
