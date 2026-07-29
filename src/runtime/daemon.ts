import path from "node:path";
import { ControlCenterService } from "../control/service.js";
import { VERSION } from "../version.js";
import { LocalApiServer, type LocalApiServerOptions } from "./api.js";
import { RuntimeDatabase } from "./database.js";
import { RuntimeEventBus } from "./events.js";
import { RemoteSwarmService } from "./swarmService.js";
import { SchedulerService } from "./schedulerService.js";
import {
  createDaemonState,
  isProcessAlive,
  readDaemonState,
  removeDaemonState,
  writeDaemonState,
  type DaemonState
} from "./state.js";

export interface OracleDaemonOptions {
  homeDir: string;
  host?: string;
  port?: number;
  token?: string;
  databasePath?: string;
  workspaceRoot?: string;
  backendFactory?: LocalApiServerOptions["backendFactory"];
  allowRemote?: boolean;
  onShutdown?: () => void;
}

export class OracleDaemon {
  private database?: RuntimeDatabase;
  private events?: RuntimeEventBus;
  private scheduler?: SchedulerService;
  private control?: ControlCenterService;
  private swarm?: RemoteSwarmService;
  private api?: LocalApiServer;
  private state?: DaemonState;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: OracleDaemonOptions) {}

  get isRunning(): boolean {
    return Boolean(this.state);
  }

  get daemonState(): DaemonState | undefined {
    return this.state;
  }

  async start(): Promise<DaemonState> {
    if (this.state) return this.state;
    const existing = await readDaemonState(this.options.homeDir);
    if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
      throw new Error(`Oracle daemon is already running with pid ${existing.pid}.`);
    }
    if (existing) await removeDaemonState(this.options.homeDir, existing.pid);

    const host = this.options.host ?? "127.0.0.1";
    this.assertBinding(host);
    const requestedPort = this.options.port ?? 4777;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      throw new Error(`Invalid runtime port: ${requestedPort}`);
    }

    this.database = new RuntimeDatabase(
      this.options.homeDir,
      this.options.databasePath ?? path.join(this.options.homeDir, "runtime", "oracle.db")
    );
    this.events = new RuntimeEventBus(this.database);
    this.swarm = new RemoteSwarmService(this.database, this.events);
    this.scheduler = new SchedulerService(this.database, this.events);
    const workspaceRoot = path.resolve(this.options.workspaceRoot ?? process.cwd());
    this.control = new ControlCenterService(
      this.database,
      this.events,
      this.scheduler,
      {
        homeDir: this.options.homeDir,
        workspaceRoot
      }
    );

    const provisional = createDaemonState({
      host,
      port: requestedPort,
      token: this.options.token,
      databasePath: this.database.filePath,
      workspaceRoot
    });
    this.api = new LocalApiServer({
      host,
      port: requestedPort,
      token: provisional.token,
      version: VERSION,
      homeDir: this.options.homeDir,
      workspaceRoot,
      backendFactory: this.options.backendFactory,
      scheduler: this.scheduler,
      control: this.control,
      events: this.events,
      swarm: this.swarm,
      onShutdown: () => {
        void this.stop().then(() => this.options.onShutdown?.());
      }
    });

    try {
      const schedulerStart = await this.scheduler.start(this.options.homeDir);
      this.control.start();
      const address = await this.api.start();
      this.state = { ...provisional, port: address.port };
      await writeDaemonState(this.options.homeDir, this.state);
      this.events.publish("daemon.started", {
        pid: this.state.pid,
        host: this.state.host,
        port: this.state.port,
        version: this.state.version,
        storage: "sqlite",
        importedLegacyTasks: schedulerStart.importedLegacyTasks
      });
      return this.state;
    } catch (error) {
      await this.api.stop().catch(() => undefined);
      await this.scheduler.stop().catch(() => undefined);
      this.control.stop();
      this.database.close();
      this.api = undefined;
      this.scheduler = undefined;
      this.control = undefined;
      this.swarm = undefined;
      this.events = undefined;
      this.database = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    const state = this.state;
    if (!state) return;
    this.events?.publish("daemon.stopping", { pid: state.pid });
    this.control?.stop();
    this.control?.dispose();
    await this.scheduler?.stop();
    await this.api?.stop();
    this.database?.close();
    await removeDaemonState(this.options.homeDir, state.pid);
    this.state = undefined;
    this.api = undefined;
    this.scheduler = undefined;
    this.control = undefined;
    this.swarm = undefined;
    this.events = undefined;
    this.database = undefined;
  }

  private assertBinding(host: string): void {
    if (
      !this.options.allowRemote
      && !["127.0.0.1", "::1", "localhost"].includes(host)
    ) {
      throw new Error(
        `Runtime API must bind to loopback unless allowRemote is enabled; received "${host}".`
      );
    }
  }
}
