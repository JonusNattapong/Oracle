import fs from "node:fs/promises";
import path from "node:path";
import { RuntimeDatabase } from "../runtime/database.js";
import type { TaskProposal } from "../tasks/consensus.js";
import type { SwarmWorkflow } from "./swarm.js";

export interface StoredSwarmProposal {
  workflow: SwarmWorkflow;
  proposal: TaskProposal;
}

/**
 * SQLite-backed swarm workflow projection with a one-time, non-destructive
 * import of legacy ~/.oracle/swarms/*.json files.
 */
export class SwarmStore {
  private readonly database: RuntimeDatabase;
  private importPromise?: Promise<void>;

  constructor(private readonly homeDir: string) {
    this.database = new RuntimeDatabase(homeDir);
  }

  dispose(): void {
    this.database.close();
  }

  async save(workflow: SwarmWorkflow): Promise<void> {
    await this.ensureLegacyImported();
    this.validateId(workflow.id);
    workflow.updatedAt = new Date().toISOString();
    this.database.connection.prepare(`
      INSERT INTO coordination_workflows (
        id, record_json, status, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        record_json = excluded.record_json,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      workflow.id,
      JSON.stringify(workflow),
      workflow.status,
      workflow.updatedAt
    );
  }

  async get(id: string): Promise<SwarmWorkflow | null> {
    await this.ensureLegacyImported();
    try {
      this.validateId(id);
    } catch {
      return null;
    }
    const row = this.database.connection.prepare(`
      SELECT record_json FROM coordination_workflows WHERE id = ?
    `).get(id) as { record_json: string } | undefined;
    return row
      ? this.normalize(JSON.parse(row.record_json) as SwarmWorkflow)
      : null;
  }

  async list(): Promise<SwarmWorkflow[]> {
    await this.ensureLegacyImported();
    const rows = this.database.connection.prepare(`
      SELECT record_json FROM coordination_workflows
      ORDER BY updated_at DESC
    `).all() as unknown as Array<{ record_json: string }>;
    return rows.map((row) =>
      this.normalize(JSON.parse(row.record_json) as SwarmWorkflow)
    );
  }

  async findProposal(proposalId: string): Promise<StoredSwarmProposal | null> {
    for (const workflow of await this.list()) {
      const proposal = workflow.proposals.find(
        (candidate) => candidate.id === proposalId
      );
      if (proposal) return { workflow, proposal };
    }
    return null;
  }

  async findByTask(taskId: string): Promise<SwarmWorkflow | null> {
    return (await this.list()).find(
      (workflow) => workflow.taskIds.includes(taskId)
    ) ?? null;
  }

  private normalize(workflow: SwarmWorkflow): SwarmWorkflow {
    if (!Array.isArray(workflow.proposals)) workflow.proposals = [];
    if (!Array.isArray(workflow.taskIds)) workflow.taskIds = [];
    if (!Array.isArray(workflow.messageIds)) workflow.messageIds = [];
    if (!workflow.status) {
      workflow.status = workflow.taskIds.length ? "active" : "initializing";
    }
    if (!workflow.recovery) workflow.recovery = { attempts: 0 };
    return workflow;
  }

  private validateId(id: string): void {
    if (!/^swarm_[a-z0-9_-]+$/i.test(id)) {
      throw new Error(`Invalid swarm workflow id "${id}".`);
    }
  }

  private ensureLegacyImported(): Promise<void> {
    this.importPromise ??= this.importLegacy();
    return this.importPromise;
  }

  private async importLegacy(): Promise<void> {
    const completed = this.database.connection.prepare(`
      SELECT value FROM runtime_metadata
      WHERE key = 'coordination_workflows_imported_v6'
    `).get() as { value: string } | undefined;
    if (completed?.value === "1") return;

    const directory = path.join(this.homeDir, "swarms");
    let names: string[] = [];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch {
      // A missing legacy workflow directory is normal.
    }
    const insert = this.database.connection.prepare(`
      INSERT OR IGNORE INTO coordination_workflows (
        id, record_json, status, updated_at
      ) VALUES (?, ?, ?, ?)
    `);
    for (const name of names) {
      try {
        const workflow = this.normalize(JSON.parse(
          await fs.readFile(path.join(directory, name), "utf8")
        ) as SwarmWorkflow);
        this.validateId(workflow.id);
        insert.run(
          workflow.id,
          JSON.stringify(workflow),
          workflow.status,
          workflow.updatedAt
        );
      } catch {
        // Keep malformed legacy files untouched for manual recovery.
      }
    }
    this.database.connection.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at)
      VALUES ('coordination_workflows_imported_v6', '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
    `).run(new Date().toISOString());
  }
}
