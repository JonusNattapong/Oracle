import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeDatabase } from "../runtime/database.js";

/**
 * SQLite-backed inter-agent message bus.
 *
 * Version 0.5 keeps the public API stable while replacing the old
 * read/modify/write JSON files with transactional rows. On first use, legacy
 * ~/.oracle/messages/*.json files are imported with INSERT OR IGNORE and are
 * intentionally left untouched as a recovery copy.
 */

export interface AgentMessage {
  id: string;
  ts: string;
  from: string;
  to: string;
  subject?: string;
  body: string;
  replyTo?: string;
  taskId?: string;
  workflowId?: string;
  coordinationEventId?: string;
  readBy: string[];
}

export interface SendInput {
  from: string;
  to: string;
  body: string;
  subject?: string;
  replyTo?: string;
  taskId?: string;
  workflowId?: string;
  coordinationEventId?: string;
}

interface MessageRow {
  id: string;
  ts: string;
  from_agent: string;
  to_agent: string;
  subject: string | null;
  body: string;
  reply_to: string | null;
  task_id: string | null;
  workflow_id: string | null;
  coordination_event_id: string | null;
  dead_lettered_at: string | null;
}

function generateId(timestamp: string): string {
  const now = timestamp.replace(/[-:.TZ]/g, "").slice(0, 17);
  return `${now}-${crypto.randomBytes(4).toString("hex")}`;
}

export class MessageStore {
  private readonly database: RuntimeDatabase;
  private importPromise?: Promise<void>;
  private lastTimestampMs = 0;

  constructor(private readonly homeDir: string) {
    this.database = new RuntimeDatabase(homeDir);
  }

  dispose(): void {
    this.database.close();
  }

  async send(input: SendInput): Promise<AgentMessage> {
    await this.ensureLegacyImported();
    const deterministicId = input.coordinationEventId
      ? `coord-${crypto.createHash("sha256")
        .update(`${input.taskId ?? ""}:${input.coordinationEventId}`)
        .digest("hex")
        .slice(0, 24)}`
      : undefined;
    if (deterministicId) {
      const existing = await this.get(deterministicId);
      if (existing) return existing;
    }

    const timestampMs = Math.max(Date.now(), this.lastTimestampMs + 1);
    this.lastTimestampMs = timestampMs;
    const timestamp = new Date(timestampMs).toISOString();
    const message: AgentMessage = {
      id: deterministicId ?? generateId(timestamp),
      ts: timestamp,
      from: input.from,
      to: input.to,
      subject: input.subject,
      body: input.body,
      replyTo: input.replyTo,
      taskId: input.taskId,
      workflowId: input.workflowId,
      coordinationEventId: input.coordinationEventId,
      readBy: []
    };
    this.insert(message, false);
    return message;
  }

  async get(id: string): Promise<AgentMessage | null> {
    await this.ensureLegacyImported();
    this.validateId(id);
    const row = this.database.connection.prepare(`
      SELECT * FROM coordination_messages WHERE id = ?
    `).get(id) as MessageRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  async inbox(
    agent: string,
    opts?: { unreadOnly?: boolean; limit?: number }
  ): Promise<AgentMessage[]> {
    await this.ensureLegacyImported();
    const unreadOnly = opts?.unreadOnly ?? true;
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 1000);
    const rows = this.database.connection.prepare(`
      SELECT m.*
      FROM coordination_messages m
      WHERE m.dead_lettered_at IS NULL
        AND (m.to_agent = ? OR m.to_agent = '*')
        AND m.from_agent != ?
        AND (
          ? = 0 OR NOT EXISTS (
            SELECT 1 FROM coordination_message_reads r
            WHERE r.message_id = m.id AND r.agent_name = ?
          )
        )
      ORDER BY m.ts DESC
      LIMIT ?
    `).all(agent, agent, unreadOnly ? 1 : 0, agent, limit) as unknown as MessageRow[];
    return rows.reverse().map((row) => this.fromRow(row));
  }

  async ack(agent: string, ids: string[]): Promise<string[]> {
    await this.ensureLegacyImported();
    const now = new Date().toISOString();
    const acked: string[] = [];
    const exists = this.database.connection.prepare(`
      SELECT id FROM coordination_messages
      WHERE id = ? AND dead_lettered_at IS NULL
    `);
    const insert = this.database.connection.prepare(`
      INSERT OR IGNORE INTO coordination_message_reads (
        message_id, agent_name, read_at
      ) VALUES (?, ?, ?)
    `);
    this.database.connection.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        this.validateId(id);
        if (!exists.get(id)) continue;
        if (insert.run(id, agent, now).changes > 0) acked.push(id);
      }
      this.database.connection.exec("COMMIT");
    } catch (error) {
      this.database.connection.exec("ROLLBACK");
      throw error;
    }
    return acked;
  }

  async ackAll(agent: string): Promise<string[]> {
    const unread = await this.inbox(agent, { unreadOnly: true, limit: 1000 });
    return this.ack(agent, unread.map((message) => message.id));
  }

  async search(opts: {
    since?: string;
    until?: string;
    query?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<AgentMessage[]> {
    await this.ensureLegacyImported();
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 1000);
    const rows = this.database.connection.prepare(`
      SELECT * FROM coordination_messages
      WHERE dead_lettered_at IS NULL
      ORDER BY ts DESC
    `).all() as unknown as MessageRow[];
    const query = opts.query?.toLowerCase();
    return rows
      .filter((row) => !opts.since || row.ts >= opts.since)
      .filter((row) => !opts.until || row.ts <= opts.until)
      .filter((row) => !opts.from || row.from_agent === opts.from)
      .filter((row) => !opts.to || row.to_agent === opts.to)
      .filter((row) => {
        if (!query) return true;
        return row.body.toLowerCase().includes(query)
          || (row.subject ?? "").toLowerCase().includes(query);
      })
      .slice(0, limit)
      .map((row) => this.fromRow(row));
  }

  async listForTask(taskId: string): Promise<AgentMessage[]> {
    await this.ensureLegacyImported();
    const rows = this.database.connection.prepare(`
      SELECT * FROM coordination_messages
      WHERE task_id = ? AND dead_lettered_at IS NULL
      ORDER BY ts ASC
    `).all(taskId) as unknown as MessageRow[];
    return rows.map((row) => this.fromRow(row));
  }

  async thread(id: string): Promise<AgentMessage[]> {
    await this.ensureLegacyImported();
    this.validateId(id);
    const all = await this.readAll();
    const byId = new Map(all.map((message) => [message.id, message]));
    let root = byId.get(id);
    if (!root) return [];
    const visited = new Set<string>([root.id]);
    while (root.replyTo && byId.get(root.replyTo) && !visited.has(root.replyTo)) {
      root = byId.get(root.replyTo)!;
      visited.add(root.id);
    }

    const result: AgentMessage[] = [];
    const queue = [root.id];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const message = byId.get(current);
      if (message) result.push(message);
      for (const candidate of all) {
        if (candidate.replyTo === current) queue.push(candidate.id);
      }
    }
    return result.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async deadLetter(id: string): Promise<boolean> {
    await this.ensureLegacyImported();
    this.validateId(id);
    const result = this.database.connection.prepare(`
      UPDATE coordination_messages
      SET dead_lettered_at = ?
      WHERE id = ? AND dead_lettered_at IS NULL
    `).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  async prune(opts: {
    staleRecipients?: string[];
    maxAgeDays?: number;
  }): Promise<number> {
    await this.ensureLegacyImported();
    const all = await this.readAll();
    const now = Date.now();
    const staleRecipients = new Set(opts.staleRecipients ?? []);
    const maxAge = opts.maxAgeDays ? opts.maxAgeDays * 86_400_000 : 0;
    let pruned = 0;
    for (const message of all) {
      const tooOld = maxAge > 0 && now - Date.parse(message.ts) > maxAge;
      const orphan = staleRecipients.has(message.to);
      if ((tooOld || orphan) && await this.deadLetter(message.id)) pruned++;
    }
    return pruned;
  }

  async deadLetterStats(): Promise<{ count: number; sizeBytes: number }> {
    await this.ensureLegacyImported();
    const row = this.database.connection.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(
          length(body) + length(COALESCE(subject, '')) + length(id)
        ), 0) AS size_bytes
      FROM coordination_messages
      WHERE dead_lettered_at IS NOT NULL
    `).get() as { count: number; size_bytes: number };
    return { count: row.count, sizeBytes: row.size_bytes };
  }

  async purgeDeadLetter(maxAgeDays = 30): Promise<number> {
    await this.ensureLegacyImported();
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    const result = this.database.connection.prepare(`
      DELETE FROM coordination_messages
      WHERE dead_lettered_at IS NOT NULL AND dead_lettered_at < ?
    `).run(cutoff);
    return Number(result.changes);
  }

  private async readAll(): Promise<AgentMessage[]> {
    const rows = this.database.connection.prepare(`
      SELECT * FROM coordination_messages
      WHERE dead_lettered_at IS NULL
      ORDER BY ts ASC
    `).all() as unknown as MessageRow[];
    return rows.map((row) => this.fromRow(row));
  }

  private insert(message: AgentMessage, ignoreExisting: boolean): boolean {
    const result = this.database.connection.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO coordination_messages (
        id, ts, from_agent, to_agent, subject, body, reply_to, task_id,
        workflow_id, coordination_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.ts,
      message.from,
      message.to,
      message.subject ?? null,
      message.body,
      message.replyTo ?? null,
      message.taskId ?? null,
      message.workflowId ?? null,
      message.coordinationEventId ?? null
    );
    if (result.changes > 0 && message.readBy.length) {
      const insertRead = this.database.connection.prepare(`
        INSERT OR IGNORE INTO coordination_message_reads (
          message_id, agent_name, read_at
        ) VALUES (?, ?, ?)
      `);
      for (const agent of message.readBy) {
        insertRead.run(message.id, agent, message.ts);
      }
    }
    return result.changes > 0;
  }

  private fromRow(row: MessageRow): AgentMessage {
    const reads = this.database.connection.prepare(`
      SELECT agent_name FROM coordination_message_reads
      WHERE message_id = ? ORDER BY agent_name ASC
    `).all(row.id) as unknown as Array<{ agent_name: string }>;
    return {
      id: row.id,
      ts: row.ts,
      from: row.from_agent,
      to: row.to_agent,
      subject: row.subject ?? undefined,
      body: row.body,
      replyTo: row.reply_to ?? undefined,
      taskId: row.task_id ?? undefined,
      workflowId: row.workflow_id ?? undefined,
      coordinationEventId: row.coordination_event_id ?? undefined,
      readBy: reads.map((row) => row.agent_name)
    };
  }

  private validateId(id: string): void {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`Invalid message id: ${id}`);
  }

  private ensureLegacyImported(): Promise<void> {
    this.importPromise ??= this.importLegacy();
    return this.importPromise;
  }

  private async importLegacy(): Promise<void> {
    const completed = this.database.connection.prepare(`
      SELECT value FROM runtime_metadata
      WHERE key = 'coordination_messages_imported_v5'
    `).get() as { value: string } | undefined;
    if (completed?.value === "1") return;

    let names: string[] = [];
    const directory = path.join(this.homeDir, "messages");
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch {
      // A missing legacy directory is a normal fresh installation.
    }
    for (const name of names) {
      try {
        const message = JSON.parse(
          await fs.readFile(path.join(directory, name), "utf8")
        ) as AgentMessage;
        if (!Array.isArray(message.readBy)) message.readBy = [];
        this.validateId(message.id);
        this.insert(message, true);
      } catch {
        // Preserve malformed legacy files for manual recovery; skip importing.
      }
    }
    this.database.connection.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at)
      VALUES ('coordination_messages_imported_v5', '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
    `).run(new Date().toISOString());
  }
}
