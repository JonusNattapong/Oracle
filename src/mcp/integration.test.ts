import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { DEFAULT_PROJECT_CONFIG } from "../config/project.js";
import { ConsultService } from "../core/consult.js";
import type { Provider } from "../providers/provider.js";
import { FileSessionStore } from "../session/store.js";
import { SkillRegistry } from "../skills/registry.js";
import { OracleRegistry } from "../oracles/registry.js";
import { MemoryAdapter } from "../memory/adapter.js";
import { ProfileStore } from "../identity/profile.js";
import { MessageStore } from "../messaging/store.js";
import { AgentRegistry } from "../messaging/registry.js";
import { TaskStore } from "../tasks/store.js";
import { registerOracleTools } from "./server.js";

const provider: Provider = {
  id: "codex",
  capabilities: {
    consult: true,
    toolUse: false,
    images: false,
    continuation: false,
    structuredUsage: false,
    supportedPlatforms: ["darwin", "linux", "win32"]
  },
  healthCheck: async () => [],
  async run(request) {
    return { text: `ANSWER: ${request.userPrompt}`, usage: {} };
  }
};

let lastBrowserImageCount = 0;
const browserProvider: Provider = {
  ...provider,
  id: "chatgpt-browser",
  capabilities: {
    ...provider.capabilities,
    accountMemory: true,
    images: true
  },
  async run(request) {
    lastBrowserImageCount = request.images?.length ?? 0;
    if (request.userPrompt.includes("Return an image")) {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const outputDir = path.join(request.artifactsDir!, "images");
      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, "output-001.png");
      await fs.writeFile(outputPath, png);
      return {
        text: "BROWSER IMAGE ANSWER",
        usage: {},
        images: [{
          path: outputPath,
          mimeType: "image/png" as const,
          sizeBytes: png.length,
          fileName: "output-001.png",
          alt: "Test output"
        }]
      };
    }
    return {
      text: `BROWSER ANSWER: ${request.userPrompt}`,
      usage: {},
      accountMemorySaved: request.accountMemory ? true : undefined
    };
  }
};

let root: string;
let client: Client;
let server: McpServer;
let messages: MessageStore;
let agentRegistry: AgentRegistry;
let tasks: TaskStore;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-mcp-test-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "sample.ts"), "export const answer = 42;", "utf8");
  await fs.writeFile(
    path.join(root, "src", "sample.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = new McpServer({ name: "oracle-test", version: "1.0.0" });
  const skills = new SkillRegistry(root, path.join(root, ".oracle", "skills"));
  await skills.load();
  const oracles = new OracleRegistry(root, root);
  registerOracleTools({
    server,
    service: new ConsultService(
      provider,
      new FileSessionStore(path.join(root, ".sessions")),
      undefined,
      undefined,
      (id) => id === "chatgpt-browser" ? browserProvider : provider
    ),
    config: { ...DEFAULT_PROJECT_CONFIG, include: ["src/**/*.ts"], exclude: [] },
    workspaceRoot: root,
    providerId: "codex",
    skills,
    oracles,
    memory: new MemoryAdapter(root),
    globalMemory: new MemoryAdapter(root, "global-memory"),
    profile: new ProfileStore(root),
    messages: (messages = new MessageStore(root)),
    agentRegistry: (agentRegistry = new AgentRegistry(root)),
    tasks: (tasks = new TaskStore(root)),
    providerChecks: async () => [{ name: "provider", ok: true, detail: "test" }]
  });
  client = new Client({ name: "oracle-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  messages?.dispose();
  agentRegistry?.dispose();
  tasks?.dispose();
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Oracle MCP tools", () => {
  test("lists all focused tools", async () => {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toContain("oracle_ask");
    expect(tools).toContain("oracle_doctor");
    expect(tools).toContain("oracle_skills");
    expect(tools).toContain("oracle_oracle_list");
    expect(tools).toContain("oracle_oracle_register");
    expect(tools).toContain("oracle_memory_list");
    expect(tools).toContain("oracle_memory_remember");
    expect(tools).toContain("oracle_memory_clear");
    expect(tools).toContain("oracle_identity_show");
    expect(tools).toContain("oracle_identity_setup");
    expect(tools).toContain("oracle_persona_set");
    expect(tools).toContain("oracle_msg_send");
    expect(tools).toContain("oracle_msg_inbox");
    expect(tools).toContain("oracle_msg_ack");
    expect(tools).toContain("oracle_msg_thread");
    expect(tools).toContain("oracle_task_create");
    expect(tools).toContain("oracle_task_list");
    expect(tools).toContain("oracle_task_get");
    expect(tools).toContain("oracle_task_update");
    expect(tools).toContain("oracle_task_checklist");
    expect(tools).toContain("oracle_task_submit");
    expect(tools).toContain("oracle_task_close");
    expect(tools).toContain("oracle_task_propose");
    expect(tools).toContain("oracle_task_vote");
    expect(tools).toContain("oracle_coordination_recover");
  });

  test("keeps project and global memory scopes separate", async () => {
    const saved = await client.callTool({
      name: "oracle_memory_remember",
      arguments: { scope: "global", agent: "claude-lead", type: "fact", content: "Always use the shared release checklist." }
    });
    expect(saved.isError).not.toBe(true);

    const global = await client.callTool({
      name: "oracle_memory_search",
      arguments: { scope: "global", query: "shared release checklist" }
    });
    expect((global.structuredContent as { count: number }).count).toBe(1);

    const project = await client.callTool({
      name: "oracle_memory_search",
      arguments: { scope: "project", query: "shared release checklist" }
    });
    expect((project.structuredContent as { count: number }).count).toBe(0);
  });

  test("register onboards an agent: roster + unread in one call, presence tracked", async () => {
    // A message is waiting before the agent ever registers.
    const pre = await client.callTool({
      name: "oracle_msg_send",
      arguments: { from: "scout", to: "newbie", body: "welcome task: read the skill doc" }
    });
    expect(pre.isError).not.toBe(true);

    const onboard = await client.callTool({
      name: "oracle_msg_register",
      arguments: { name: "newbie", role: "test agent" }
    });
    expect(onboard.isError).not.toBe(true);
    const sc = onboard.structuredContent as {
      agent: { name: string; role: string };
      unreadCount: number;
      roster: Array<{ name: string }>;
    };
    expect(sc.agent.name).toBe("newbie");
    expect(sc.agent.role).toBe("test agent");
    expect(sc.unreadCount).toBe(1);

    // Roster lists the registered agent; presence marked active.
    const agents = await client.callTool({ name: "oracle_msg_agents", arguments: {} });
    const list = (agents.structuredContent as { agents: Array<{ name: string; active: boolean }> }).agents;
    const me = list.find((a) => a.name === "newbie");
    expect(me).toBeDefined();
    expect(me?.active).toBe(true);

    // Re-registering is idempotent, not an error.
    const again = await client.callTool({
      name: "oracle_msg_register",
      arguments: { name: "newbie" }
    });
    expect(again.isError).not.toBe(true);
    expect((again.structuredContent as { agent: { role: string } }).agent.role).toBe("test agent");
  });

  test("agents exchange messages through the shared bus", async () => {
    const sent = await client.callTool({
      name: "oracle_msg_send",
      arguments: { from: "claude", to: "codex", body: "please review src/sample.ts", subject: "review" }
    });
    expect(sent.isError).not.toBe(true);
    const msgId = (sent.structuredContent as { id: string }).id;

    // Recipient sees it, sender does not.
    const codexInbox = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "codex" }
    });
    expect((codexInbox.structuredContent as { count: number }).count).toBe(1);
    const claudeInbox = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "claude" }
    });
    expect((claudeInbox.structuredContent as { count: number }).count).toBe(0);

    // Reply threads back to the original.
    const reply = await client.callTool({
      name: "oracle_msg_send",
      arguments: { from: "codex", to: "claude", body: "looks good", replyTo: msgId }
    });
    const thread = await client.callTool({
      name: "oracle_msg_thread",
      arguments: { id: (reply.structuredContent as { id: string }).id }
    });
    expect((thread.structuredContent as { count: number }).count).toBe(2);

    // Ack clears the unread inbox.
    const acked = await client.callTool({
      name: "oracle_msg_ack",
      arguments: { agent: "codex", ids: [msgId] }
    });
    expect((acked.structuredContent as { acked: string[] }).acked).toEqual([msgId]);
    const after = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "codex" }
    });
    expect((after.structuredContent as { count: number }).count).toBe(0);
  });

  test("consults, lists, retrieves, and diagnoses", async () => {
    const consultation = await client.callTool({
      name: "oracle_ask",
      arguments: { question: "Review this project" }
    });
    expect(consultation.isError).not.toBe(true);
    expect(consultation.structuredContent).toMatchObject({
      soul: "auto",
      filesIncluded: 0
    });
    expect(typeof (consultation.structuredContent as { sessionId: string }).sessionId).toBe("string");

    const sessions = await client.callTool({ name: "oracle_sessions", arguments: { limit: 1 } });
    const sessionId = (sessions.structuredContent as { sessions: Array<{ sessionId: string }> }).sessions[0].sessionId;
    const session = await client.callTool({ name: "oracle_session_get", arguments: { sessionId } });
    expect(session.isError).not.toBe(true);

    const doctor = await client.callTool({ name: "oracle_doctor", arguments: {} });
    const expectedHealthy = Number.parseInt(process.versions.node.split(".")[0], 10) >= 24;
    expect(doctor.structuredContent).toMatchObject({ healthy: expectedHealthy });
    expect((doctor.structuredContent as { checks: Array<{ name: string }> }).checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "provider" })])
    );
  });

  test("oracle_ask routes a per-call backend override through the shared bundle service", async () => {
    const consultation = await client.callTool({
      name: "oracle_ask",
      arguments: {
        question: "Use the browser backend",
        backend: "chatgpt-browser",
        files: ["src/sample.ts"]
      }
    });
    expect(consultation.isError).not.toBe(true);
    expect(consultation.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("BROWSER ANSWER:")
        })
      ])
    );
    expect(consultation.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("export const answer = 42")
        })
      ])
    );
  });

  test("oracle_ask explicitly routes account memory without adding it to the answer prompt", async () => {
    const consultation = await client.callTool({
      name: "oracle_ask",
      arguments: {
        question: "Answer this normally",
        backend: "chatgpt-browser",
        accountMemory: "Prefers concise architecture reviews"
      }
    });

    expect(consultation.isError).not.toBe(true);
    expect(consultation.structuredContent).toMatchObject({
      accountMemoryRequested: true,
      accountMemorySaved: true
    });
    expect(consultation.content).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Prefers concise architecture reviews")
        })
      ])
    );
  });

  test("oracle_ask sends image files and returns generated images as MCP image content", async () => {
    const consultation = await client.callTool({
      name: "oracle_ask",
      arguments: {
        question: "Return an image",
        backend: "chatgpt-browser",
        files: ["src/sample.png"]
      }
    });

    expect(consultation.isError).not.toBe(true);
    expect(lastBrowserImageCount).toBe(1);
    expect(consultation.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        data: expect.any(String)
      })
    ]));
    expect(consultation.structuredContent).toMatchObject({
      images: [
        expect.objectContaining({
          fileName: "output-001.png",
          mimeType: "image/png",
          alt: "Test output"
        })
      ]
    });
  });

  test("identity_setup accepts a single freeform string as well as an array for list fields", async () => {
    // Found via real usage: preferences/habits/goals are stored as arrays,
    // but a single descriptive string is the natural first thing an agent
    // tries — it must not hard-fail, and should split into discrete items
    // rather than being stored as one giant entry.
    const stringForm = await client.callTool({
      name: "oracle_identity_setup",
      arguments: { name: "string-agent", preferences: "prefers concise diffs, likes tabs" }
    });
    expect(stringForm.isError).not.toBe(true);

    const shown = await client.callTool({ name: "oracle_identity_show", arguments: {} });
    expect((shown.structuredContent as { identity: { preferences: string[] } }).identity.preferences).toEqual([
      "prefers concise diffs",
      "likes tabs"
    ]);

    const arrayForm = await client.callTool({
      name: "oracle_identity_setup",
      arguments: { name: "array-agent", goals: ["ship feature X", "fix bug Y"] }
    });
    expect(arrayForm.isError).not.toBe(true);

    const shownArray = await client.callTool({ name: "oracle_identity_show", arguments: {} });
    expect((shownArray.structuredContent as { identity: { goals: string[] } }).identity.goals).toEqual([
      "ship feature X",
      "fix bug Y"
    ]);
  });

  test("full task lifecycle: create -> progress -> checklist gate -> submit -> review -> close", async () => {
    const created = await client.callTool({
      name: "oracle_task_create",
      arguments: {
        title: "Add rate limiting", createdBy: "lead", assignee: "builder",
        checklist: ["implement limiter", "add tests"]
      }
    });
    expect(created.isError).not.toBe(true);
    const taskId = (created.structuredContent as { task: { id: string } }).task.id;

    // Creating a task messages the assignee — they see it without being told separately.
    const inbox = await client.callTool({ name: "oracle_msg_inbox", arguments: { agent: "builder" } });
    expect((inbox.structuredContent as { count: number }).count).toBeGreaterThanOrEqual(1);

    // Progress notes accumulate as an audit trail.
    await client.callTool({
      name: "oracle_task_update",
      arguments: { id: taskId, agent: "builder", status: "in_progress", note: "starting on the limiter" }
    });

    // Submit is blocked while checklist items are unchecked.
    const blocked = await client.callTool({
      name: "oracle_task_submit",
      arguments: { id: taskId, agent: "builder", summary: "done" }
    });
    expect(blocked.isError).toBe(true);

    // Check off both items, then submit succeeds.
    await client.callTool({ name: "oracle_task_checklist", arguments: { id: taskId, index: 0, done: true } });
    await client.callTool({ name: "oracle_task_checklist", arguments: { id: taskId, index: 1, done: true } });
    const submitted = await client.callTool({
      name: "oracle_task_submit",
      arguments: { id: taskId, agent: "builder", summary: "limiter implemented and tested" }
    });
    expect(submitted.isError).not.toBe(true);
    expect((submitted.structuredContent as { task: { status: string } }).task.status).toBe("review");

    // Submitting auto-notifies the creator — no separate "I'm done" message needed.
    const leadInbox = await client.callTool({ name: "oracle_msg_inbox", arguments: { agent: "lead" } });
    const leadMsgs = (leadInbox.structuredContent as { messages: Array<{ subject?: string }> }).messages;
    expect(leadMsgs.some((m) => m.subject?.includes("ready for review"))).toBe(true);

    // Reviewer rejects once, then approves.
    const rejected = await client.callTool({
      name: "oracle_task_close",
      arguments: { id: taskId, agent: "lead", approved: false, note: "add a burst-limit test" }
    });
    expect((rejected.structuredContent as { task: { status: string } }).task.status).toBe("in_progress");

    const approved = await client.callTool({
      name: "oracle_task_close",
      arguments: { id: taskId, agent: "lead", approved: true }
    });
    expect((approved.structuredContent as { task: { status: string } }).task.status).toBe("done");

    // Full history is visible via get.
    const detail = await client.callTool({ name: "oracle_task_get", arguments: { id: taskId } });
    const notes = (detail.structuredContent as { task: { notes: unknown[] } }).task.notes;
    expect(notes.length).toBeGreaterThanOrEqual(4);
  });

  test("task consensus proposals persist and accumulate MCP votes", async () => {
    const created = await client.callTool({
      name: "oracle_task_create",
      arguments: { title: "Release candidate", createdBy: "lead", assignee: "builder" }
    });
    const taskId = (created.structuredContent as { task: { id: string } }).task.id;

    const proposed = await client.callTool({
      name: "oracle_task_propose",
      arguments: {
        taskId,
        proposerAgentId: "builder",
        proposedAction: "Deploy the release candidate",
        requiredQuorum: 2,
        approvalThresholdRatio: 0.5
      }
    });
    expect(proposed.isError).not.toBe(true);
    const proposalId = (proposed.structuredContent as { proposal: { id: string } }).proposal.id;

    const firstVote = await client.callTool({
      name: "oracle_task_vote",
      arguments: {
        proposalId,
        agentId: "reviewer",
        decision: "approve",
        justification: "review passed"
      }
    });
    expect((firstVote.structuredContent as { status: string; voteCount: number })).toMatchObject({
      status: "pending",
      voteCount: 1
    });

    const secondVote = await client.callTool({
      name: "oracle_task_vote",
      arguments: {
        proposalId,
        agentId: "qa",
        decision: "approve",
        justification: "tests passed"
      }
    });
    expect((secondVote.structuredContent as { status: string; voteCount: number })).toMatchObject({
      status: "approved",
      voteCount: 2
    });
  });

  test("coordination recovery delivers pending task messages idempotently", async () => {
    const recoveryStore = new TaskStore(root);
    const task = await recoveryStore.create({
      title: "Recover MCP notification",
      createdBy: "lead",
      assignee: "recovery-worker"
    });
    recoveryStore.dispose();

    const first = await client.callTool({ name: "oracle_coordination_recover", arguments: {} });
    const second = await client.callTool({ name: "oracle_coordination_recover", arguments: {} });
    const firstReport = (first.structuredContent as { report: { messagesDelivered: number } }).report;
    const secondReport = (second.structuredContent as { report: { messagesDelivered: number } }).report;
    expect(firstReport.messagesDelivered).toBe(1);
    expect(secondReport.messagesDelivered).toBe(0);

    const inbox = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "recovery-worker" }
    });
    const messages = (inbox.structuredContent as { messages: Array<{ taskId?: string }> }).messages;
    expect(messages.filter((message) => message.taskId === task.id)).toHaveLength(1);
  });

  test("inbox wait:true returns immediately when a message is already queued", async () => {
    // Message lands before the recipient ever waits.
    await client.callTool({
      name: "oracle_msg_send",
      arguments: { from: "waiter-sender", to: "waiter-queued", body: "already here" }
    });

    const start = Date.now();
    const waited = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "waiter-queued", wait: true, timeoutSeconds: 5 }
    });
    // Must not sit through a poll interval when there is already something to read.
    expect(Date.now() - start).toBeLessThan(1000);
    const sc = waited.structuredContent as { count: number; waitTimedOut: boolean };
    expect(sc.count).toBe(1);
    expect(sc.waitTimedOut).toBe(false);
  });

  test("inbox wait:true unblocks when a message arrives mid-wait", async () => {
    // Start waiting on an empty inbox, then send from a parallel promise after a
    // short delay — the poll loop (1.5s interval) should pick it up and return.
    const start = Date.now();
    const [waited] = await Promise.all([
      client.callTool({
        name: "oracle_msg_inbox",
        arguments: { agent: "waiter-live", wait: true, timeoutSeconds: 5 }
      }),
      new Promise((r) => setTimeout(r, 500)).then(() =>
        client.callTool({
          name: "oracle_msg_send",
          arguments: { from: "waiter-sender", to: "waiter-live", body: "arrived mid-wait" }
        })
      )
    ]);
    const elapsed = Date.now() - start;
    // Unblocked by the message, not by the 5s timeout.
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(4000);
    const sc = waited.structuredContent as {
      count: number;
      waitTimedOut: boolean;
      messages: Array<{ body: string }>;
    };
    expect(sc.count).toBe(1);
    expect(sc.waitTimedOut).toBe(false);
    expect(sc.messages[0].body).toBe("arrived mid-wait");
  });

  test("inbox wait:true reports waitTimedOut with an empty inbox when nothing arrives", async () => {
    const start = Date.now();
    const waited = await client.callTool({
      name: "oracle_msg_inbox",
      arguments: { agent: "waiter-silent", wait: true, timeoutSeconds: 1 }
    });
    // Waited out the full (short) timeout without a message.
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
    const sc = waited.structuredContent as { count: number; waitTimedOut: boolean };
    expect(sc.count).toBe(0);
    expect(sc.waitTimedOut).toBe(true);
  });
});
