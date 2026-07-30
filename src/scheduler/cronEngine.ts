import { exec } from "node:child_process";
import cron from "node-cron";
import {
  CronTaskStore,
  type CronTask,
  type CronTaskRepository,
  type CreateTaskInput,
  type UpdateTaskInput
} from "./taskStore.js";

export interface CronEngineOptions {
  homeDir?: string;
  store?: CronTaskRepository;
  onTaskStart?: (task: CronTask) => void;
  onTaskComplete?: (task: CronTask, result: "success" | "error", output: string) => void;
  runCommand?: (task: CronTask, command: string) => Promise<string>;
}

export class CronEngine {
  private store: CronTaskRepository;
  private scheduledTasks: Map<string, cron.ScheduledTask> = new Map();
  private options: CronEngineOptions;
  _running = false;

  constructor(options: CronEngineOptions) {
    if (!options.store && !options.homeDir) {
      throw new Error("CronEngine requires either store or homeDir.");
    }
    this.store = options.store ?? new CronTaskStore(options.homeDir!);
    this.options = options;
  }

  get isRunning(): boolean {
    return this._running;
  }

  set onTaskComplete(cb: CronEngineOptions["onTaskComplete"]) {
    this.options.onTaskComplete = cb;
  }

  set onTaskStart(cb: CronEngineOptions["onTaskStart"]) {
    this.options.onTaskStart = cb;
  }

  async start(): Promise<void> {
    if (this._running) return;
    const tasks = await this.store.list();
    for (const task of tasks) {
      if (task.status === "active") {
        this.scheduleTask(task);
      }
    }
    this._running = true;
  }

  async stop(): Promise<void> {
    for (const [id, task] of this.scheduledTasks) {
      task.stop();
      this.scheduledTasks.delete(id);
    }
    this._running = false;
  }

  async addTask(input: CreateTaskInput): Promise<CronTask> {
    const task = await this.store.create(input);
    if (this._running && task.status === "active") {
      this.scheduleTask(task);
    }
    return task;
  }

  async removeTask(id: string): Promise<boolean> {
    const scheduled = this.scheduledTasks.get(id);
    if (scheduled) {
      scheduled.stop();
      this.scheduledTasks.delete(id);
    }
    return this.store.delete(id);
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<CronTask | null> {
    const scheduled = this.scheduledTasks.get(id);
    if (scheduled) {
      scheduled.stop();
      this.scheduledTasks.delete(id);
    }

    const task = await this.store.update(id, input);
    if (!task) return null;

    if (this._running && task.status === "active") {
      this.scheduleTask(task);
    }
    return task;
  }

  async getTask(id: string): Promise<CronTask | null> {
    return this.store.get(id);
  }

  async listTasks(): Promise<CronTask[]> {
    return this.store.list();
  }

  async runOnce(id: string): Promise<{ result: "success" | "error"; output: string }> {
    const task = await this.store.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return this.executeTask(task);
  }

  private scheduleTask(task: CronTask): void {
    const scheduled = cron.schedule(task.cron, () => {
      void this.executeTask(task);
    });
    this.scheduledTasks.set(task.id, scheduled);
  }

  private async executeTask(task: CronTask): Promise<{ result: "success" | "error"; output: string }> {
    this.options.onTaskStart?.(task);
    try {
      const output = this.options.runCommand
        ? await this.options.runCommand(task, task.command)
        : await this.runCommand(task.command);
      await this.store.recordRun(task.id, "success", output);
      this.options.onTaskComplete?.(task, "success", output);
      return { result: "success", output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.store.recordRun(task.id, "error", msg);
      this.options.onTaskComplete?.(task, "error", msg);
      return { result: "error", output: msg };
    }
  }

  private runCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
