import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TaskStatus } from "../tasks/store.js";
import type {
  SwarmAgent,
  SwarmMessage,
  SwarmTask
} from "./swarmService.js";

export interface SwarmConnectionProfile {
  url: string;
  projectId: string;
  agentName: string;
  token: string;
  connectedAt: string;
}

export interface SwarmStatus {
  version: string;
  projectId: string;
  agent: SwarmAgent;
  agents: SwarmAgent[];
  activeTasks: number;
  unreadMessages: number;
}

export function swarmProfilePath(homeDir: string): string {
  return path.join(homeDir, "remote.json");
}

export async function saveSwarmProfile(
  homeDir: string,
  profile: SwarmConnectionProfile
): Promise<void> {
  const filePath = swarmProfilePath(homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(profile, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function loadSwarmProfile(
  homeDir: string
): Promise<SwarmConnectionProfile | null> {
  try {
    const profile = JSON.parse(
      await fs.readFile(swarmProfilePath(homeDir), "utf8")
    ) as SwarmConnectionProfile;
    if (
      !profile.url
      || !profile.projectId
      || !profile.agentName
      || !profile.token
    ) return null;
    return profile;
  } catch {
    return null;
  }
}

export async function removeSwarmProfile(homeDir: string): Promise<boolean> {
  try {
    await fs.rm(swarmProfilePath(homeDir));
    return true;
  } catch {
    return false;
  }
}

export class SwarmClient {
  readonly baseUrl: URL;

  constructor(readonly profile: SwarmConnectionProfile) {
    const url = new URL(profile.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Swarm URL must use http or https.");
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    this.baseUrl = url;
  }

  static async fromHome(homeDir: string): Promise<SwarmClient | null> {
    const profile = await loadSwarmProfile(homeDir);
    return profile ? new SwarmClient(profile) : null;
  }

  connect(): Promise<{
    projectId: string;
    agent: SwarmAgent;
    version: string;
  }> {
    return this.request("POST", "/v1/swarm/connect");
  }

  status(): Promise<SwarmStatus> {
    return this.request("GET", "/v1/swarm/status");
  }

  async listAgents(): Promise<SwarmAgent[]> {
    return (await this.request<{ agents: SwarmAgent[] }>(
      "GET",
      "/v1/swarm/agents"
    )).agents;
  }

  async send(input: {
    to: string;
    body: string;
    subject?: string;
    replyTo?: string;
    taskId?: string;
  }): Promise<SwarmMessage> {
    return (await this.request<{ message: SwarmMessage }>(
      "POST",
      "/v1/swarm/messages",
      input
    )).message;
  }

  async inbox(input: {
    all?: boolean;
    limit?: number;
  } = {}): Promise<SwarmMessage[]> {
    const query = new URLSearchParams();
    if (input.all) query.set("all", "true");
    if (input.limit) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return (await this.request<{ messages: SwarmMessage[] }>(
      "GET",
      `/v1/swarm/messages/inbox${suffix}`
    )).messages;
  }

  async acknowledge(ids: string[]): Promise<string[]> {
    return (await this.request<{ acked: string[] }>(
      "POST",
      "/v1/swarm/messages/ack",
      { ids }
    )).acked;
  }

  async createTask(input: {
    title: string;
    description?: string;
    assignee: string;
    checklist?: string[];
  }): Promise<SwarmTask> {
    return (await this.request<{ task: SwarmTask }>(
      "POST",
      "/v1/swarm/tasks",
      input
    )).task;
  }

  async listTasks(input: {
    assignee?: string;
    createdBy?: string;
    status?: TaskStatus;
    activeOnly?: boolean;
  } = {}): Promise<SwarmTask[]> {
    const query = new URLSearchParams();
    if (input.assignee) query.set("assignee", input.assignee);
    if (input.createdBy) query.set("createdBy", input.createdBy);
    if (input.status) query.set("status", input.status);
    if (input.activeOnly) query.set("active", "true");
    const suffix = query.size ? `?${query.toString()}` : "";
    return (await this.request<{ tasks: SwarmTask[] }>(
      "GET",
      `/v1/swarm/tasks${suffix}`
    )).tasks;
  }

  async getTask(id: string): Promise<SwarmTask> {
    return (await this.request<{ task: SwarmTask }>(
      "GET",
      `/v1/swarm/tasks/${encodeURIComponent(id)}`
    )).task;
  }

  async updateTask(
    id: string,
    input: { status?: TaskStatus; note?: string }
  ): Promise<SwarmTask> {
    return (await this.request<{ task: SwarmTask }>(
      "PATCH",
      `/v1/swarm/tasks/${encodeURIComponent(id)}`,
      input
    )).task;
  }

  async checkTask(id: string, index: number, done: boolean): Promise<SwarmTask> {
    return (await this.request<{ task: SwarmTask }>(
      "POST",
      `/v1/swarm/tasks/${encodeURIComponent(id)}/check`,
      { index, done }
    )).task;
  }

  async submitTask(id: string, summary: string): Promise<SwarmTask> {
    return (await this.request<{ task: SwarmTask }>(
      "POST",
      `/v1/swarm/tasks/${encodeURIComponent(id)}/submit`,
      { summary }
    )).task;
  }

  async closeTask(
    id: string,
    approved: boolean,
    note?: string
  ): Promise<SwarmTask> {
    return (await this.request<{ task: SwarmTask }>(
      "POST",
      `/v1/swarm/tasks/${encodeURIComponent(id)}/close`,
      { approved, note }
    )).task;
  }

  webSocketUrl(after = 0): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/swarm/events";
    if (after > 0) url.searchParams.set("after", String(after));
    return url.toString();
  }

  webSocketHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.profile.token}` };
  }

  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.profile.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) {
      throw new SwarmApiError(
        response.status,
        payload.error ?? `Swarm API returned ${response.status}.`
      );
    }
    return payload;
  }
}

export class SwarmApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SwarmApiError";
  }
}
