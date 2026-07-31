import type { CreateTaskInput, CronTask, UpdateTaskInput } from "../scheduler/taskStore.js";
import type {
  CompanionChannelStatus,
  CompanionDelivery,
  CompanionIntent,
  CompanionPauseState,
  CompanionStateSnapshot,
  PresenceUpdateResult,
  UpdatePresenceInput
} from "../companion/types.js";
import type {
  ApprovalExecution,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
  ControlCenterSnapshot,
  CreateApprovalInput
} from "../control/types.js";
import type { MaintenanceResult } from "../memory/maintenance.js";
import type { TaskRecord } from "../tasks/store.js";
import type { SessionRecord } from "../types.js";
import { readDaemonState, type DaemonState } from "./state.js";
import type { SwarmToken } from "./swarmService.js";

export interface RuntimeHealth {
  status: "ok";
  version: string;
  pid: number;
  uptimeSeconds: number;
  schedulerRunning: boolean;
  storage: "sqlite";
}

export class RuntimeClient {
  constructor(readonly state: DaemonState) {}

  static async connect(homeDir: string): Promise<RuntimeClient | null> {
    const state = await readDaemonState(homeDir);
    if (!state) return null;
    const client = new RuntimeClient(state);
    try {
      await client.health();
      return client;
    } catch {
      return null;
    }
  }

  health(): Promise<RuntimeHealth> {
    return this.request<RuntimeHealth>("GET", "/health", undefined, false);
  }

  async issueSwarmToken(input: {
    projectId: string;
    projectName?: string;
    agentName: string;
    role?: string;
  }): Promise<SwarmToken> {
    return (await this.request<{ token: SwarmToken }>(
      "POST",
      "/v1/swarm/tokens",
      input
    )).token;
  }

  async revokeSwarmToken(id: string): Promise<boolean> {
    try {
      return (await this.request<{ revoked: boolean }>(
        "DELETE",
        `/v1/swarm/tokens/${encodeURIComponent(id)}`
      )).revoked;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return false;
      throw error;
    }
  }

  async listSchedules(): Promise<CronTask[]> {
    return (await this.request<{ tasks: CronTask[] }>("GET", "/v1/schedules")).tasks;
  }

  async getSchedule(id: string): Promise<CronTask | null> {
    try {
      return (await this.request<{ task: CronTask }>("GET", `/v1/schedules/${id}`)).task;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createSchedule(input: CreateTaskInput): Promise<CronTask> {
    return (await this.request<{ task: CronTask }>("POST", "/v1/schedules", input)).task;
  }

  async updateSchedule(id: string, input: UpdateTaskInput): Promise<CronTask | null> {
    try {
      return (await this.request<{ task: CronTask }>("PATCH", `/v1/schedules/${id}`, input)).task;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async removeSchedule(id: string): Promise<boolean> {
    try {
      return (await this.request<{ removed: boolean }>("DELETE", `/v1/schedules/${id}`)).removed;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return false;
      throw error;
    }
  }

  runSchedule(id: string): Promise<{ result: "success" | "error"; output: string }> {
    return this.request("POST", `/v1/schedules/${id}/run`, undefined, true, 300_000);
  }

  getCompanionState(limit = 20): Promise<CompanionStateSnapshot> {
    return this.request(
      "GET",
      `/v1/companion/state?limit=${encodeURIComponent(String(limit))}`,
      undefined,
      true,
      10_000
    );
  }

  updateCompanionPresence(input: UpdatePresenceInput): Promise<PresenceUpdateResult> {
    return this.request(
      "POST",
      "/v1/companion/presence",
      input,
      true,
      10_000
    );
  }

  async evaluateCompanion(): Promise<CompanionIntent> {
    return (await this.request<{ intent: CompanionIntent }>(
      "POST",
      "/v1/companion/evaluate",
      {},
      true,
      10_000
    )).intent;
  }

  async pauseCompanion(minutes?: number): Promise<CompanionPauseState> {
    return (await this.request<{ pause: CompanionPauseState }>(
      "POST",
      "/v1/companion/pause",
      minutes === undefined ? {} : { minutes },
      true,
      10_000
    )).pause;
  }

  async resumeCompanion(): Promise<CompanionPauseState> {
    return (await this.request<{ pause: CompanionPauseState }>(
      "POST",
      "/v1/companion/resume",
      {},
      true,
      10_000
    )).pause;
  }

  forgetCompanionPresence(): Promise<{ forgotten: number }> {
    return this.request(
      "DELETE",
      "/v1/companion/presence",
      undefined,
      true,
      10_000
    );
  }

  async getCompanionChannels(): Promise<CompanionChannelStatus[]> {
    return (await this.request<{ channels: CompanionChannelStatus[] }>(
      "GET",
      "/v1/companion/channels",
      undefined,
      true,
      10_000
    )).channels;
  }

  async setCompanionChannelEnabled(
    channel: string,
    enabled: boolean
  ): Promise<CompanionChannelStatus[]> {
    return (await this.request<{ channels: CompanionChannelStatus[] }>(
      "POST",
      "/v1/companion/channels",
      { channel, enabled },
      true,
      10_000
    )).channels;
  }

  async getCompanionDeliveries(limit = 20): Promise<CompanionDelivery[]> {
    return (await this.request<{ deliveries: CompanionDelivery[] }>(
      "GET",
      `/v1/companion/deliveries?limit=${encodeURIComponent(String(limit))}`,
      undefined,
      true,
      10_000
    )).deliveries;
  }

  notifyTestCompanion(): Promise<{
    intent: CompanionIntent;
    deliveries: CompanionDelivery[];
  }> {
    return this.request(
      "POST",
      "/v1/companion/notify-test",
      {},
      true,
      30_000
    );
  }

  requestStop(): Promise<{ stopping: boolean }> {
    return this.request("POST", "/v1/daemon/stop");
  }

  getControlSnapshot(): Promise<ControlCenterSnapshot> {
    return this.request("GET", "/v1/control/snapshot", undefined, true, 10_000);
  }

  async listApprovals(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return (await this.request<{ approvals: ApprovalRequest[] }>(
      "GET",
      `/v1/control/approvals${query}`,
      undefined,
      true,
      10_000
    )).approvals;
  }

  async getApproval(id: string): Promise<ApprovalRequest | null> {
    try {
      return (await this.request<{ approval: ApprovalRequest }>(
        "GET",
        `/v1/control/approvals/${encodeURIComponent(id)}`
      )).approval;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRequest> {
    return (await this.request<{ approval: ApprovalRequest }>(
      "POST",
      "/v1/control/approvals",
      input
    )).approval;
  }

  async decideApproval(id: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    return (await this.request<{ approval: ApprovalRequest }>(
      "POST",
      `/v1/control/approvals/${encodeURIComponent(id)}/decision`,
      decision,
      true,
      10_000
    )).approval;
  }

  async claimApprovalExecution(
    id: string,
    input: { payloadHash: string; claimedBy: string }
  ): Promise<ApprovalExecution> {
    return (await this.request<{ execution: ApprovalExecution }>(
      "POST",
      `/v1/control/approvals/${encodeURIComponent(id)}/execution/claim`,
      input,
      true,
      10_000
    )).execution;
  }

  async completeApprovalExecution(
    executionId: string,
    input: { status: "completed" | "failed"; result?: Record<string, unknown> }
  ): Promise<ApprovalExecution> {
    return (await this.request<{ execution: ApprovalExecution }>(
      "POST",
      `/v1/control/executions/${encodeURIComponent(executionId)}/complete`,
      input,
      true,
      10_000
    )).execution;
  }

  async submitControlTask(
    id: string,
    input: { actor: string; summary?: string }
  ): Promise<TaskRecord> {
    return (await this.request<{ task: TaskRecord }>(
      "POST",
      `/v1/control/tasks/${encodeURIComponent(id)}/submit`,
      input,
      true,
      10_000
    )).task;
  }

  async closeControlTask(
    id: string,
    input: { actor: string; note?: string }
  ): Promise<TaskRecord> {
    return (await this.request<{ task: TaskRecord }>(
      "POST",
      `/v1/control/tasks/${encodeURIComponent(id)}/close`,
      input,
      true,
      10_000
    )).task;
  }

  async runMemoryMaintenance(): Promise<{ project: MaintenanceResult; global: MaintenanceResult }> {
    return (await this.request<{ result: { project: MaintenanceResult; global: MaintenanceResult } }>(
      "POST",
      "/v1/control/memory/maintenance",
      undefined,
      true,
      60_000
    )).result;
  }

  async consult(input: {
    question: string;
    files?: string[];
    backend?: string;
    provider?: string;
    model?: string;
    systemPrompt?: string;
    cwd?: string;
    conversationId?: string;
    previousResponseId?: string;
    accountMemory?: string;
  }): Promise<SessionRecord> {
    return await this.request<SessionRecord>(
      "POST",
      "/v1/consult",
      input,
      true,
      input.accountMemory ? 360_000 : 120_000
    );
  }

  async getConsultSession(sessionId: string): Promise<SessionRecord> {
    return await this.request<SessionRecord>(
      "GET",
      `/v1/consult/${encodeURIComponent(sessionId)}`,
      undefined,
      true,
      10_000
    );
  }

  controlCenterUrl(): string {
    const url = new URL("/control", this.baseUrl());
    url.hash = new URLSearchParams({ token: this.state.token }).toString();
    return url.toString();
  }

  webSocketUrl(after = 0): string {
    const url = new URL(this.baseUrl().replace(/^http/, "ws"));
    url.pathname = "/v1/events";
    url.searchParams.set("token", this.state.token);
    if (after > 0) url.searchParams.set("after", String(after));
    return url.toString();
  }

  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
    authenticated = true,
    timeoutMs = 2000
  ): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl()), {
      method,
      headers: {
        accept: "application/json",
        ...(authenticated ? { authorization: `Bearer ${this.state.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) {
      throw new RuntimeApiError(response.status, payload.error ?? `Runtime API returned ${response.status}.`);
    }
    return payload;
  }

  private baseUrl(): string {
    const host = this.state.host.includes(":") ? `[${this.state.host}]` : this.state.host;
    return `http://${host}:${this.state.port}/`;
  }
}

export class RuntimeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RuntimeApiError";
  }
}
