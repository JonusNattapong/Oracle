import cron from "node-cron";
import { CronEngine } from "../scheduler/cronEngine.js";
import type { CreateTaskInput, CronTask, UpdateTaskInput } from "../scheduler/taskStore.js";
import { RuntimeDatabase, SqliteCronTaskStore } from "./database.js";
import { RuntimeEventBus } from "./events.js";
import { loadPolicy, validateCommand } from "../agent/policy.js";
import { SandboxRunner } from "../sandbox/runner.js";

export class SchedulerService {
  readonly store: SqliteCronTaskStore;
  readonly engine: CronEngine;

  constructor(
    private readonly database: RuntimeDatabase,
    private readonly events: RuntimeEventBus,
    private readonly workspaceRoot = process.cwd()
  ) {
    this.store = new SqliteCronTaskStore(database);
    this.engine = new CronEngine({
      store: this.store,
      onTaskStart: (task) => {
        this.events.publish("scheduler.run.started", { taskId: task.id, name: task.name });
      },
      onTaskComplete: (task, result, output) => {
        this.events.publish("scheduler.run.completed", {
          taskId: task.id,
          name: task.name,
          result,
          output: output.slice(0, 4000)
        });
      },
      runCommand: async (_task, command) => {
        const policy = await loadPolicy(this.workspaceRoot);
        validateCommand(command, policy);
        const runner = new SandboxRunner({
          policy: policy.sandbox,
          workspaceRoot: this.workspaceRoot,
          recorder: this.database
        });
        const result = await runner.run(command, 300_000);
        return [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
      }
    });
  }

  get isRunning(): boolean {
    return this.engine.isRunning;
  }

  async start(homeDir: string): Promise<{ importedLegacyTasks: number }> {
    const importedLegacyTasks = await this.store.importLegacyDirectory(homeDir);
    await this.engine.start();
    this.events.publish("scheduler.started", {
      activeTasks: (await this.list()).filter((task) => task.status === "active").length,
      importedLegacyTasks
    });
    return { importedLegacyTasks };
  }

  async stop(): Promise<void> {
    await this.engine.stop();
    this.events.publish("scheduler.stopped", {});
  }

  async list(): Promise<CronTask[]> {
    return this.engine.listTasks();
  }

  async get(id: string): Promise<CronTask | null> {
    return this.engine.getTask(id);
  }

  async create(input: CreateTaskInput): Promise<CronTask> {
    this.validate(input.cron);
    validateCommand(input.command, await loadPolicy(this.workspaceRoot));
    const task = await this.engine.addTask(input);
    this.events.publish("scheduler.task.created", { task });
    return task;
  }

  async update(id: string, input: UpdateTaskInput): Promise<CronTask | null> {
    if (input.cron !== undefined) this.validate(input.cron);
    if (input.command !== undefined) validateCommand(input.command, await loadPolicy(this.workspaceRoot));
    const task = await this.engine.updateTask(id, input);
    if (task) this.events.publish("scheduler.task.updated", { task });
    return task;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.engine.removeTask(id);
    if (removed) this.events.publish("scheduler.task.removed", { taskId: id });
    return removed;
  }

  async run(id: string): Promise<{ result: "success" | "error"; output: string }> {
    return this.engine.runOnce(id);
  }

  private validate(expression: string): void {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }
  }
}
