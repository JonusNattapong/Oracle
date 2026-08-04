import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RuntimeDatabase } from "./database.js";
import { RuntimeEventBus } from "./events.js";
import { SchedulerService } from "./schedulerService.js";

let home: string;
let workspace: string;
let database: RuntimeDatabase;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-sandbox-scheduler-home-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-sandbox-scheduler-workspace-"));
  database = new RuntimeDatabase(home);
});

afterEach(async () => {
  database.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("SchedulerService sandbox boundary", () => {
  test("records scheduler command evidence through the shared runner", async () => {
    const service = new SchedulerService(database, new RuntimeEventBus(database), workspace);
    const task = await service.create({ name: "sandbox evidence", cron: "0 0 * * *", command: "echo sandbox-schedule" });

    await expect(service.run(task.id)).resolves.toMatchObject({ result: "success" });
    expect(database.connection.prepare(`
      SELECT mode, network, workspace_root, exit_code FROM sandbox_runs
      ORDER BY created_at DESC LIMIT 1
    `).get()).toEqual({
      mode: "none",
      network: "none",
      workspace_root: workspace,
      exit_code: 0
    });
  }, 15_000);

  test("rejects scheduler commands forbidden by workspace policy", async () => {
    await fs.mkdir(path.join(workspace, ".oracle"));
    await fs.writeFile(path.join(workspace, ".oracle", "policy.json"), JSON.stringify({
      forbiddenCommands: ["blocked-command"]
    }), "utf8");
    const service = new SchedulerService(database, new RuntimeEventBus(database), workspace);
    await expect(service.create({ name: "blocked", cron: "0 0 * * *", command: "blocked-command now" }))
      .rejects.toThrow("forbidden pattern");
  });
});
