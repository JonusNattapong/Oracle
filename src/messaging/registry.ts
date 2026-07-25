import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeDatabase } from "../runtime/database.js";

export interface AgentRecord {
  name: string;
  role?: string;
  registeredAt: string;
  lastSeen: string;
}

interface AgentRow {
  name: string;
  role: string | null;
  registered_at: string;
  last_seen_at: string;
}

export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/**
 * SQLite presence registry with a one-time, non-destructive import of the
 * legacy ~/.oracle/agents/*.json records.
 */
export class AgentRegistry {
  private readonly database: RuntimeDatabase;
  private importPromise?: Promise<void>;

  constructor(private readonly homeDir: string) {
    this.database = new RuntimeDatabase(homeDir);
  }

  async register(name: string, role?: string): Promise<AgentRecord> {
    await this.ensureLegacyImported();
    const normalized = this.validateName(name);
    const existing = await this.get(normalized);
    const now = new Date().toISOString();
    const record: AgentRecord = {
      name: normalized,
      role: role ?? existing?.role,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now
    };
    this.database.connection.prepare(`
      INSERT INTO coordination_agents (
        name, role, registered_at, last_seen_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        role = excluded.role,
        last_seen_at = excluded.last_seen_at
    `).run(
      record.name,
      record.role ?? null,
      record.registeredAt,
      record.lastSeen
    );
    return record;
  }

  async get(name: string): Promise<AgentRecord | null> {
    await this.ensureLegacyImported();
    const normalized = this.validateName(name);
    const row = this.database.connection.prepare(`
      SELECT name, role, registered_at, last_seen_at
      FROM coordination_agents WHERE name = ?
    `).get(normalized) as AgentRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  async touch(name: string): Promise<void> {
    try {
      await this.ensureLegacyImported();
      const normalized = this.validateName(name);
      this.database.connection.prepare(`
        UPDATE coordination_agents SET last_seen_at = ? WHERE name = ?
      `).run(new Date().toISOString(), normalized);
    } catch {
      // Presence must never break message delivery.
    }
  }

  async list(): Promise<Array<AgentRecord & { active: boolean }>> {
    await this.ensureLegacyImported();
    const rows = this.database.connection.prepare(`
      SELECT name, role, registered_at, last_seen_at
      FROM coordination_agents ORDER BY last_seen_at DESC
    `).all() as unknown as AgentRow[];
    const now = Date.now();
    return rows.map((row) => {
      const record = this.fromRow(row);
      return {
        ...record,
        active: now - Date.parse(record.lastSeen) < ACTIVE_WINDOW_MS
      };
    });
  }

  async stale(windowMs = ACTIVE_WINDOW_MS * 2): Promise<AgentRecord[]> {
    const all = await this.list();
    const cutoff = Date.now() - windowMs;
    return all.filter((agent) => Date.parse(agent.lastSeen) < cutoff);
  }

  async unregister(name: string): Promise<boolean> {
    await this.ensureLegacyImported();
    const result = this.database.connection.prepare(`
      DELETE FROM coordination_agents WHERE name = ?
    `).run(this.validateName(name));
    return result.changes > 0;
  }

  private fromRow(row: AgentRow): AgentRecord {
    return {
      name: row.name,
      role: row.role ?? undefined,
      registeredAt: row.registered_at,
      lastSeen: row.last_seen_at
    };
  }

  private validateName(name: string): string {
    const normalized = name.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]{0,63}$/.test(normalized)) {
      throw new Error(
        `Invalid agent name "${name}": use 1-64 letters/digits/hyphens/underscores, starting with a letter or digit.`
      );
    }
    return normalized;
  }

  private ensureLegacyImported(): Promise<void> {
    this.importPromise ??= this.importLegacy();
    return this.importPromise;
  }

  private async importLegacy(): Promise<void> {
    const completed = this.database.connection.prepare(`
      SELECT value FROM runtime_metadata
      WHERE key = 'coordination_agents_imported_v5'
    `).get() as { value: string } | undefined;
    if (completed?.value === "1") return;

    const directory = path.join(this.homeDir, "agents");
    let names: string[] = [];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch {
      // A missing legacy agent directory is normal.
    }
    const insert = this.database.connection.prepare(`
      INSERT OR IGNORE INTO coordination_agents (
        name, role, registered_at, last_seen_at
      ) VALUES (?, ?, ?, ?)
    `);
    for (const name of names) {
      try {
        const record = JSON.parse(
          await fs.readFile(path.join(directory, name), "utf8")
        ) as AgentRecord;
        const normalized = this.validateName(record.name);
        insert.run(
          normalized,
          record.role ?? null,
          record.registeredAt,
          record.lastSeen
        );
      } catch {
        // Keep malformed files untouched for manual recovery.
      }
    }
    this.database.connection.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at)
      VALUES ('coordination_agents_imported_v5', '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
    `).run(new Date().toISOString());
  }
}
