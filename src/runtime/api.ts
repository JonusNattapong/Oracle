import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { renderControlCenterDashboard } from "../control/dashboard.js";
import type { ControlCenterService } from "../control/service.js";
import {
  ApprovalAuthorizationError,
  ApprovalConflictError
} from "../control/approvalStore.js";
import type {
  ApprovalKind,
  ApprovalRisk,
  ApprovalStatus
} from "../control/types.js";
import type { SchedulerService } from "./schedulerService.js";
import type { RuntimeEventBus } from "./events.js";
import {
  RemoteSwarmService,
  type SwarmIdentity
} from "./swarmService.js";

export interface LocalApiServerOptions {
  host: string;
  port: number;
  token: string;
  version: string;
  scheduler: SchedulerService;
  control: ControlCenterService;
  events: RuntimeEventBus;
  swarm: RemoteSwarmService;
  onShutdown: () => void;
}

export class LocalApiServer {
  private readonly server: Server;
  private readonly webSockets = new WebSocketServer({ noServer: true });
  private readonly swarmSockets = new Map<WebSocket, string>();
  private unsubscribeEvents?: () => void;

  constructor(private readonly options: LocalApiServerOptions) {
    this.server = http.createServer((request, response) => {
      void this.route(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${this.options.host}`);
      const runtimeEvents = url.pathname === "/v1/events" && this.authorized(request, url);
      const swarmIdentity = url.pathname === "/v1/swarm/events"
        ? this.swarmIdentity(request, url)
        : null;
      if (!runtimeEvents && !swarmIdentity) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        if (swarmIdentity) this.swarmSockets.set(webSocket, swarmIdentity.projectId);
        this.webSockets.emit("connection", webSocket, request);
      });
    });
    this.webSockets.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", `http://${this.options.host}`);
      const after = this.integer(url.searchParams.get("after"), 0);
      const projectId = this.swarmSockets.get(socket);
      socket.send(JSON.stringify({
        type: projectId ? "swarm.connected" : "runtime.connected",
        payload: {
          version: this.options.version,
          ...(projectId
            ? { projectId }
            : { schedulerRunning: this.options.scheduler.isRunning })
        }
      }));
      for (const event of this.options.events.history(after, 100)) {
        if (
          projectId
          && (
            !event.type.startsWith("swarm.")
            || event.payload.projectId !== projectId
          )
        ) continue;
        socket.send(JSON.stringify(event));
      }
      socket.on("close", () => this.swarmSockets.delete(socket));
    });
  }

  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.unsubscribeEvents = this.options.events.subscribe((event) => {
      const encoded = JSON.stringify(event);
      for (const client of this.webSockets.clients) {
        const projectId = this.swarmSockets.get(client);
        if (
          projectId
          && (
            !event.type.startsWith("swarm.")
            || event.payload.projectId !== projectId
          )
        ) continue;
        if (client.readyState === WebSocket.OPEN) client.send(encoded);
      }
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Runtime API did not bind a TCP port.");
    return { host: this.options.host, port: address.port };
  }

  async stop(): Promise<void> {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    for (const client of this.webSockets.clients) client.close(1001, "daemon stopping");
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.options.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        this.json(response, 200, {
          status: "ok",
          version: this.options.version,
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          schedulerRunning: this.options.scheduler.isRunning,
          storage: "sqlite"
        });
        return;
      }

      if (
        request.method === "GET"
        && (url.pathname === "/control" || url.pathname === "/control/")
      ) {
        this.html(response, 200, renderControlCenterDashboard());
        return;
      }

      if (
        url.pathname.startsWith("/v1/swarm/")
        && !url.pathname.startsWith("/v1/swarm/tokens")
      ) {
        const identity = this.swarmIdentity(request, url);
        if (!identity) {
          this.json(response, 401, { error: "Invalid or revoked swarm token." });
          return;
        }
        if (await this.routeSwarm(request, response, url, identity)) return;
        this.json(response, 404, { error: "Not found" });
        return;
      }

      if (!this.authorized(request, url)) {
        this.json(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/swarm/tokens") {
        const body = await this.body(request);
        const issued = this.options.swarm.issueToken({
          projectId: this.requiredString(body.projectId, "projectId"),
          projectName: this.optionalString(body.projectName, "projectName"),
          agentName: this.requiredString(body.agentName, "agentName"),
          role: this.optionalString(body.role, "role")
        });
        this.json(response, 201, { token: issued });
        return;
      }

      const swarmTokenMatch = url.pathname.match(
        /^\/v1\/swarm\/tokens\/(token-[a-f0-9]+)$/i
      );
      if (request.method === "DELETE" && swarmTokenMatch) {
        const revoked = this.options.swarm.revokeToken(swarmTokenMatch[1]);
        this.json(
          response,
          revoked ? 200 : 404,
          revoked ? { revoked: true } : { error: "Token not found" }
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/events") {
        const after = this.integer(url.searchParams.get("after"), 0);
        const limit = this.integer(url.searchParams.get("limit"), 100);
        this.json(response, 200, { events: this.options.events.history(after, limit) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/daemon/stop") {
        this.json(response, 202, { stopping: true });
        setImmediate(this.options.onShutdown);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/control/snapshot") {
        this.json(response, 200, await this.options.control.snapshot());
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/control/approvals") {
        const status = this.approvalStatus(url.searchParams.get("status"));
        this.json(response, 200, {
          approvals: await this.options.control.listApprovals(status)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/control/approvals") {
        const body = await this.body(request);
        const approval = await this.options.control.createApproval({
          kind: this.approvalKind(body.kind),
          title: this.requiredString(body.title, "title"),
          description: this.optionalString(body.description, "description"),
          requestedBy: this.requiredString(body.requestedBy, "requestedBy"),
          assignedTo: this.requiredString(body.assignedTo, "assignedTo"),
          authorizedReviewers: this.optionalStringArray(
            body.authorizedReviewers,
            "authorizedReviewers"
          ),
          requiredApprovals: this.optionalPositiveInteger(
            body.requiredApprovals,
            "requiredApprovals"
          ),
          risk: this.approvalRisk(body.risk),
          taskId: this.optionalString(body.taskId, "taskId"),
          messageId: this.optionalString(body.messageId, "messageId"),
          workflowId: this.optionalString(body.workflowId, "workflowId"),
          expiresAt: this.optionalString(body.expiresAt, "expiresAt"),
          expiresInMinutes: this.optionalPositiveNumber(
            body.expiresInMinutes,
            "expiresInMinutes"
          ),
          action: this.optionalAction(body.action),
          checkpointId: this.optionalString(body.checkpointId, "checkpointId"),
          localOnly: this.optionalBoolean(body.localOnly, "localOnly"),
          metadata: this.optionalRecord(body.metadata, "metadata")
        });
        this.json(response, 201, { approval });
        return;
      }

      const executionClaimMatch = url.pathname.match(
        /^\/v1\/control\/approvals\/(approval-[a-z0-9-]+)\/execution\/claim$/i
      );
      if (request.method === "POST" && executionClaimMatch) {
        const body = await this.body(request);
        const execution = await this.options.control.claimExecution(executionClaimMatch[1], {
          payloadHash: this.requiredString(body.payloadHash, "payloadHash"),
          claimedBy: this.requiredString(body.claimedBy, "claimedBy")
        });
        this.json(response, 201, { execution });
        return;
      }

      const executionCompleteMatch = url.pathname.match(
        /^\/v1\/control\/executions\/(execution-[a-z0-9-]+)\/complete$/i
      );
      if (request.method === "POST" && executionCompleteMatch) {
        const body = await this.body(request);
        if (body.status !== "completed" && body.status !== "failed") {
          throw new Error("status must be completed or failed.");
        }
        const execution = await this.options.control.completeExecution({
          executionId: executionCompleteMatch[1],
          status: body.status,
          result: this.optionalRecord(body.result, "result")
        });
        this.json(response, 200, { execution });
        return;
      }

      const approvalMatch = url.pathname.match(
        /^\/v1\/control\/approvals\/(approval-[a-z0-9-]+)(?:\/(decision))?$/i
      );
      if (approvalMatch) {
        const approvalId = approvalMatch[1];
        if (request.method === "GET" && !approvalMatch[2]) {
          const approval = this.options.control.getApproval(approvalId);
          this.json(
            response,
            approval ? 200 : 404,
            approval ? { approval } : { error: "Approval not found" }
          );
          return;
        }
        if (request.method === "POST" && approvalMatch[2] === "decision") {
          const body = await this.body(request);
          const decision = body.decision;
          if (decision !== "approve" && decision !== "reject") {
            throw new Error("decision must be approve or reject.");
          }
          const approval = await this.options.control.decide(approvalId, {
            decision,
            decidedBy: this.requiredString(body.decidedBy, "decidedBy"),
            expectedVersion: this.requiredPositiveInteger(
              body.expectedVersion,
              "expectedVersion"
            ),
            channel: this.approvalDecisionChannel(body.channel),
            note: this.optionalString(body.note, "note")
          });
          this.json(response, 200, { approval });
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/v1/schedules") {
        this.json(response, 200, { tasks: await this.options.scheduler.list() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/schedules") {
        const body = await this.body(request);
        const task = await this.options.scheduler.create({
          name: this.requiredString(body.name, "name"),
          cron: this.requiredString(body.cron, "cron"),
          command: this.requiredString(body.command, "command"),
          description: this.optionalString(body.description, "description")
        });
        this.json(response, 201, { task });
        return;
      }

      const match = url.pathname.match(/^\/v1\/schedules\/([a-z0-9-]+)(?:\/(run))?$/i);
      if (match) {
        const taskId = match[1];
        if (request.method === "GET" && !match[2]) {
          const task = await this.options.scheduler.get(taskId);
          this.json(response, task ? 200 : 404, task ? { task } : { error: "Task not found" });
          return;
        }
        if (request.method === "PATCH" && !match[2]) {
          const body = await this.body(request);
          const task = await this.options.scheduler.update(taskId, {
            name: this.optionalString(body.name, "name"),
            cron: this.optionalString(body.cron, "cron"),
            command: this.optionalString(body.command, "command"),
            description: this.optionalString(body.description, "description"),
            status: body.status === undefined
              ? undefined
              : this.taskStatus(body.status)
          });
          this.json(response, task ? 200 : 404, task ? { task } : { error: "Task not found" });
          return;
        }
        if (request.method === "DELETE" && !match[2]) {
          const removed = await this.options.scheduler.remove(taskId);
          this.json(response, removed ? 200 : 404, removed ? { removed: true } : { error: "Task not found" });
          return;
        }
        if (request.method === "POST" && match[2] === "run") {
          const result = await this.options.scheduler.run(taskId);
          // Command failure is a scheduler result, not an HTTP transport
          // failure. Callers need the structured output to set their own
          // process status and display stderr.
          this.json(response, 200, result);
          return;
        }
      }

      this.json(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof ApprovalConflictError
        ? 409
        : error instanceof ApprovalAuthorizationError
          ? 403
          : /not found/i.test(message)
            ? 404
            : 400;
      this.json(response, status, { error: message });
    }
  }

  private async routeSwarm(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    identity: SwarmIdentity
  ): Promise<boolean> {
    if (request.method === "POST" && url.pathname === "/v1/swarm/connect") {
      const agent = this.options.swarm.connect(identity);
      this.json(response, 200, {
        projectId: identity.projectId,
        agent,
        version: this.options.version
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/swarm/heartbeat") {
      this.json(response, 200, { agent: this.options.swarm.heartbeat(identity) });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/swarm/status") {
      const agent = this.options.swarm.heartbeat(identity);
      const agents = this.options.swarm.listAgents(identity.projectId);
      const tasks = this.options.swarm.listTasks(identity, { activeOnly: true });
      const unread = this.options.swarm.inbox(identity, { unreadOnly: true, limit: 500 });
      this.json(response, 200, {
        version: this.options.version,
        projectId: identity.projectId,
        agent,
        agents,
        activeTasks: tasks.length,
        unreadMessages: unread.length
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/swarm/agents") {
      this.options.swarm.heartbeat(identity);
      this.json(response, 200, {
        agents: this.options.swarm.listAgents(identity.projectId)
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/swarm/messages") {
      const body = await this.body(request);
      const message = this.options.swarm.sendMessage(identity, {
        to: this.requiredString(body.to, "to"),
        body: this.requiredString(body.body, "body"),
        subject: this.optionalString(body.subject, "subject"),
        replyTo: this.optionalString(body.replyTo, "replyTo"),
        taskId: this.optionalString(body.taskId, "taskId")
      });
      this.json(response, 201, { message });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/swarm/messages/inbox") {
      const unreadOnly = url.searchParams.get("all") !== "true";
      const limit = this.integer(url.searchParams.get("limit"), 50);
      this.json(response, 200, {
        messages: this.options.swarm.inbox(identity, { unreadOnly, limit })
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/swarm/messages/ack") {
      const body = await this.body(request);
      const ids = this.optionalStringArray(body.ids, "ids") ?? [];
      this.json(response, 200, {
        acked: this.options.swarm.acknowledge(identity, ids)
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/swarm/tasks") {
      const statusValue = url.searchParams.get("status");
      const status = statusValue
        ? this.collaborationTaskStatus(statusValue)
        : undefined;
      this.json(response, 200, {
        tasks: this.options.swarm.listTasks(identity, {
          assignee: url.searchParams.get("assignee") ?? undefined,
          createdBy: url.searchParams.get("createdBy") ?? undefined,
          status,
          activeOnly: url.searchParams.get("active") === "true"
        })
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/swarm/tasks") {
      const body = await this.body(request);
      const task = this.options.swarm.createTask(identity, {
        title: this.requiredString(body.title, "title"),
        description: this.optionalString(body.description, "description"),
        assignee: this.requiredString(body.assignee, "assignee"),
        checklist: this.optionalStringArray(body.checklist, "checklist")
      });
      this.json(response, 201, { task });
      return true;
    }

    const taskMatch = url.pathname.match(
      /^\/v1\/swarm\/tasks\/(task-[a-z0-9-]+)(?:\/(check|submit|close))?$/i
    );
    if (!taskMatch) return false;
    const taskId = taskMatch[1];
    const action = taskMatch[2];

    if (request.method === "GET" && !action) {
      const task = this.options.swarm.getTask(identity.projectId, taskId);
      this.json(
        response,
        task ? 200 : 404,
        task ? { task } : { error: "Task not found" }
      );
      return true;
    }

    if (request.method === "PATCH" && !action) {
      const body = await this.body(request);
      const task = this.options.swarm.updateTask(identity, taskId, {
        status: body.status === undefined
          ? undefined
          : this.collaborationTaskStatus(body.status),
        note: this.optionalString(body.note, "note")
      });
      this.json(response, 200, { task });
      return true;
    }

    if (request.method === "POST" && action === "check") {
      const body = await this.body(request);
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new Error("index must be a non-negative integer.");
      }
      if (typeof body.done !== "boolean") throw new Error("done must be a boolean.");
      const task = this.options.swarm.checkTask(identity, taskId, index, body.done);
      this.json(response, 200, { task });
      return true;
    }

    if (request.method === "POST" && action === "submit") {
      const body = await this.body(request);
      const task = this.options.swarm.submitTask(
        identity,
        taskId,
        this.requiredString(body.summary, "summary")
      );
      this.json(response, 200, { task });
      return true;
    }

    if (request.method === "POST" && action === "close") {
      const body = await this.body(request);
      if (typeof body.approved !== "boolean") throw new Error("approved must be a boolean.");
      const task = this.options.swarm.closeTask(identity, taskId, {
        approved: body.approved,
        note: this.optionalString(body.note, "note")
      });
      this.json(response, 200, { task });
      return true;
    }

    return false;
  }

  private authorized(request: IncomingMessage, url: URL): boolean {
    return this.requestToken(request, url) === this.options.token;
  }

  private swarmIdentity(request: IncomingMessage, url: URL): SwarmIdentity | null {
    const token = this.requestToken(request, url);
    return token ? this.options.swarm.authenticate(token) : null;
  }

  private requestToken(request: IncomingMessage, url: URL): string | undefined {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const header = request.headers["x-oracle-token"];
    const query = url.searchParams.get("token");
    return bearer
      ?? (typeof header === "string" ? header : undefined)
      ?? query
      ?? undefined;
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1_000_000) throw new Error("Request body exceeds 1 MB.");
      chunks.push(buffer);
    }
    if (!chunks.length) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
    return value;
  }

  private optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`${field} must be a string.`);
    return value;
  }

  private taskStatus(value: unknown): "active" | "paused" | "deleted" {
    if (value === "active" || value === "paused" || value === "deleted") return value;
    throw new Error("status must be active, paused, or deleted.");
  }

  private collaborationTaskStatus(
    value: unknown
  ): "pending" | "in_progress" | "review" | "done" | "blocked" | "cancelled" {
    if (
      value === "pending"
      || value === "in_progress"
      || value === "review"
      || value === "done"
      || value === "blocked"
      || value === "cancelled"
    ) return value;
    throw new Error(
      "status must be pending, in_progress, review, done, blocked, or cancelled."
    );
  }

  private approvalKind(value: unknown): ApprovalKind | undefined {
    if (value === undefined || value === null) return undefined;
    if (value === "task_review" || value === "command" || value === "policy" || value === "custom") {
      return value;
    }
    throw new Error("kind must be task_review, command, policy, or custom.");
  }

  private approvalRisk(value: unknown): ApprovalRisk | undefined {
    if (value === undefined || value === null) return undefined;
    if (value === "low" || value === "medium" || value === "high") return value;
    throw new Error("risk must be low, medium, or high.");
  }

  private approvalStatus(value: string | null): ApprovalStatus | undefined {
    if (value === null || value === "") return undefined;
    if (
      value === "pending"
      || value === "approved"
      || value === "rejected"
      || value === "cancelled"
      || value === "expired"
    ) {
      return value;
    }
    throw new Error("status must be pending, approved, rejected, cancelled, or expired.");
  }

  private approvalDecisionChannel(
    value: unknown
  ): "api" | "cli" | "tui" | "dashboard" | "telegram" | "recovery" | undefined {
    if (value === undefined || value === null) return undefined;
    if (
      value === "api"
      || value === "cli"
      || value === "tui"
      || value === "dashboard"
      || value === "telegram"
      || value === "recovery"
    ) return value;
    throw new Error("channel is invalid.");
  }

  private optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${field} must be an object.`);
    }
    return value as Record<string, unknown>;
  }

  private optionalStringArray(value: unknown, field: string): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${field} must be an array of non-empty strings.`);
    }
    return value;
  }

  private requiredPositiveInteger(value: unknown, field: string): number {
    if (!Number.isInteger(value) || Number(value) < 1) {
      throw new Error(`${field} must be a positive integer.`);
    }
    return Number(value);
  }

  private optionalPositiveInteger(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    return this.requiredPositiveInteger(value, field);
  }

  private optionalPositiveNumber(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${field} must be greater than zero.`);
    }
    return value;
  }

  private optionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
    return value;
  }

  private optionalAction(value: unknown): { type: string; payload: Record<string, unknown> } | undefined {
    if (value === undefined || value === null) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("action must be an object.");
    }
    const action = value as Record<string, unknown>;
    return {
      type: this.requiredString(action.type, "action.type"),
      payload: this.optionalRecord(action.payload, "action.payload") ?? {}
    };
  }

  private integer(value: string | null, fallback: number): number {
    if (value === null) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    const encoded = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(encoded),
      "cache-control": "no-store"
    });
    response.end(encoded);
  }

  private html(response: ServerResponse, status: number, content: string): void {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(content),
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join("; "),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    });
    response.end(content);
  }
}
