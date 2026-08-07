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
import { registerMessagingTools } from "./messagingTools.js";
import { registerTaskTools } from "./taskTools.js";

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
    lastSystemPrompt = request.systemPrompt;
    return { text: `ANSWER: ${request.userPrompt}`, usage: {} };
  }
};

let lastSystemPrompt = "";
let lastBrowserImageCount = 0;
let lastBrowserTool: string | undefined;
const browserProvider: Provider = {
  ...provider,
  id: "chatgpt-browser",
  capabilities: {
    ...provider.capabilities,
    accountMemory: true,
    composerTools: true,
    images: true
  },
  async run(request) {
    lastBrowserImageCount = request.images?.length ?? 0;
    lastBrowserTool = request.tool;
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
    providerChecks: async () => [{ name: "provider", ok: true, detail: "test" }]
  });

  // Messaging and task tools are no longer part of the default MCP surface;
  // they ship in `oracle-msg-mcp`. Register them here the way that binary does,
  // so the behaviour below is still covered where it actually lives.
  messages = new MessageStore(root);
  agentRegistry = new AgentRegistry(root);
  tasks = new TaskStore(root);
  registerMessagingTools(server, messages, agentRegistry);
  registerTaskTools(server, tasks, messages, agentRegistry);
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
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("Oracle MCP tools", () => {
  test("lists all focused tools", async () => {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toContain("oracle_ask");
    expect(tools).toContain("oracle_doctor");
    expect(tools).toContain("oracle_memory_search");
    expect(tools).toContain("oracle_memory_remember");
    expect(tools).toContain("oracle_memory_maintain");
    expect(tools).toContain("oracle_relay");
    expect(tools).toContain("oracle_run");
    expect(tools).toContain("oracle_identity_show");
    expect(tools).toContain("oracle_awareness_show");
    expect(tools).toContain("oracle_msg_send");
    expect(tools).toContain("oracle_task_create");
  });

  test("the default surface leaves out messaging, tasks and GitHub", async () => {
    // Every tool a client loads costs it context and one more way to pick the
    // wrong one. These three groups are reachable through the CLI and `gh`, so
    // they are not part of what `oracle-mcp` advertises.
    const bare = new McpServer({ name: "oracle-bare", version: "1.0.0" });
    registerOracleTools({
      server: bare,
      service: new ConsultService(provider, new FileSessionStore(path.join(root, ".sessions2"))),
      config: { ...DEFAULT_PROJECT_CONFIG, include: ["src/**/*.ts"], exclude: [] },
      workspaceRoot: root,
      providerId: "codex",
      skills: new SkillRegistry(root, path.join(root, ".oracle", "skills")),
      oracles: new OracleRegistry(root, root),
      memory: new MemoryAdapter(root),
      profile: new ProfileStore(root),
      providerChecks: async () => [{ name: "provider", ok: true, detail: "test" }]
    });

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const bareClient = new Client({ name: "bare-client", version: "1.0.0" });
    await bare.connect(st);
    await bareClient.connect(ct);
    try {
      const names = (await bareClient.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("oracle_ask");
      expect(names.filter((n) => /_msg_|_task_|_github_/.test(n))).toEqual([]);
    } finally {
      await bareClient.close();
      await bare.close();
    }
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

  test("search without a query lists recent entries instead of failing", async () => {
    // The old surface had a separate oracle_memory_list; folding it in means an
    // omitted query has to mean "recent", not "bad request".
    await client.callTool({
      name: "oracle_memory_remember",
      arguments: { agent: "tester", type: "fact", content: "Recent-listing probe entry." }
    });

    const listed = await client.callTool({
      name: "oracle_memory_search",
      arguments: { type: "fact", limit: 5 }
    });

    expect(listed.isError).not.toBe(true);
    const body = listed.structuredContent as { mode: string; count: number };
    expect(body.mode).toBe("recent");
    expect(body.count).toBeGreaterThan(0);
  });

  test("oracle_ask returns citation metadata for recalled memory", async () => {
    await client.callTool({
      name: "oracle_memory_remember",
      arguments: { agent: "tester", type: "fact", content: "Deploys require two approvals before production." }
    });
    const answer = await client.callTool({
      name: "oracle_ask",
      arguments: { question: "How many approvals do deploys require?" }
    });
    expect(answer.isError).not.toBe(true);
    const body = answer.structuredContent as { citations: Array<{ ref: string; id: string; kind: string }>; citationValidation: { unknown: string[] } };
    expect(body.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: "m1", kind: "memory" })
    ]));
    expect(body.citationValidation.unknown).toEqual([]);
  });

  test("maintain reports stats and runs housekeeping actions", async () => {
    const stats = await client.callTool({
      name: "oracle_memory_maintain",
      arguments: { action: "stats" }
    });
    expect(stats.isError).not.toBe(true);
    expect((stats.structuredContent as { stats: { total: number } }).stats.total)
      .toBeGreaterThanOrEqual(0);

    // clear_working replaced a tool of its own; it must still be reachable.
    const cleared = await client.callTool({
      name: "oracle_memory_maintain",
      arguments: { action: "clear_working", agent: "tester" }
    });
    expect(cleared.isError).not.toBe(true);
    expect(cleared.structuredContent).toHaveProperty("cleared");
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

    // Session browsing left the MCP surface for `oracle status` / `oracle
    // session <id>`; the record itself must still be written.
    const stored = await new FileSessionStore(path.join(root, ".sessions")).list(1);
    expect(stored).toHaveLength(1);
    expect(stored[0].sessionId).toBe((consultation.structuredContent as { sessionId: string }).sessionId);

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

  test("oracle_run provides one flow for consult and approved action handoff", async () => {
    const consultation = await client.callTool({
      name: "oracle_run",
      arguments: { prompt: "Explain the sample answer", mode: "consult" }
    });
    expect(consultation.isError).not.toBe(true);
    expect(consultation.structuredContent).toMatchObject({
      flow: { mode: "consult", status: "completed", requiresApproval: false }
    });

    const plan = await client.callTool({
      name: "oracle_run",
      arguments: { prompt: "Implement the sample answer change", mode: "act" }
    });
    expect(plan.isError).not.toBe(true);
    expect(plan.structuredContent).toMatchObject({
      flow: { mode: "act", status: "approval_required", requiresApproval: true }
    });

    const handoff = await client.callTool({
      name: "oracle_run",
      arguments: { prompt: "Implement the sample answer change", mode: "act", confirm: true }
    });
    expect(handoff.isError).not.toBe(true);
    expect(handoff.structuredContent).toMatchObject({
      flow: { mode: "act", status: "handoff_required" }
    });
  });

  test("oracle_ask exposes ChatGPT Web Search and Deep Research controls", async () => {
    const webSearch = await client.callTool({
      name: "oracle_ask",
      arguments: {
        question: "Search the web for this answer",
        backend: "chatgpt-browser",
        web_search: true
      }
    });
    expect(webSearch.isError).not.toBe(true);
    expect(lastBrowserTool).toBe("web-search");

    const deepResearch = await client.callTool({
      name: "oracle_ask",
      arguments: {
        question: "Research this topic deeply",
        backend: "chatgpt-browser",
        deep_research: true
      }
    });
    expect(deepResearch.isError).not.toBe(true);
    expect(lastBrowserTool).toBe("deep-research");

    const conflicting = await client.callTool({
      name: "oracle_ask",
      arguments: {
        question: "Choose one research mode",
        backend: "chatgpt-browser",
        web_search: true,
        deep_research: true
      }
    });
    expect(conflicting.isError).toBe(true);
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

  test("oracle_relay relays a question and archives it as working + insight memory", async () => {
    const relay = await client.callTool({
      name: "oracle_relay",
      arguments: { prompt: "What is the purpose of Oracle?", agent: "relayer" }
    });
    expect(relay.isError).not.toBe(true);
    expect(relay.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("ANSWER:") })
      ])
    );
    const body = relay.structuredContent as { memory: { workingEntryId: string; storedEntryId: string; storedType: string } };
    expect(body.memory.storedType).toBe("insight");
    expect(body.memory.workingEntryId).toBeDefined();
    expect(body.memory.storedEntryId).toBeDefined();

    // The Q&A should be searchable in memory.
    const found = await client.callTool({
      name: "oracle_memory_search",
      arguments: { query: "purpose of Oracle", tags: ["relay"], agent: "relayer", type: "insight" }
    });
    expect((found.structuredContent as { count: number }).count).toBeGreaterThanOrEqual(1);

    // The working request should be visible too.
    const working = await client.callTool({
      name: "oracle_memory_search",
      arguments: { agent: "relayer", type: "working", tags: ["relay", "request"], limit: 5 }
    });
    expect((working.structuredContent as { count: number }).count).toBeGreaterThanOrEqual(1);
  });

  test("oracle_relay stores the answer as a fact when store_as=fact", async () => {
    const relay = await client.callTool({
      name: "oracle_relay",
      arguments: { prompt: "The release train runs on Fridays", store_as: "fact", agent: "scheduler" }
    });
    expect(relay.isError).not.toBe(true);
    const body = relay.structuredContent as { memory: { storedType: string } };
    expect(body.memory.storedType).toBe("fact");

    const facts = await client.callTool({
      name: "oracle_memory_search",
      arguments: { query: "release train", type: "fact", agent: "scheduler" }
    });
    expect((facts.structuredContent as { count: number }).count).toBeGreaterThanOrEqual(1);
  });

  test("oracle_relay with conversation_id enables turn continuity", async () => {
    const convo = "relay-convo-test";
    const first = await client.callTool({
      name: "oracle_relay",
      arguments: { prompt: "Remember the word flibbertigibbet", agent: "converser", conversation_id: convo }
    });
    expect(first.isError).not.toBe(true);

    const second = await client.callTool({
      name: "oracle_relay",
      arguments: { prompt: "What word did I just ask you to remember?", agent: "converser", conversation_id: convo }
    });
    expect(second.isError).not.toBe(true);

    // The self-log working entry should contain the first question.
    const log = await client.callTool({
      name: "oracle_memory_search",
      arguments: { query: "flibbertigibbet", agent: "oracle", type: "working" }
    });
    expect((log.structuredContent as { count: number }).count).toBeGreaterThanOrEqual(1);
  });

  test("exposes and injects the current self-awareness snapshot", async () => {
    await new ProfileStore(root).saveIdentity({
      name: "awareness-operator",
      role: "maintainer",
      preferences: ["evidence first"]
    });

    const shown = await client.callTool({ name: "oracle_awareness_show", arguments: {} });
    expect(shown.isError).not.toBe(true);
    expect(shown.structuredContent).toMatchObject({
      self: {
        name: "Oracle",
        role: expect.stringContaining("coordination")
      },
      operator: {
        name: "awareness-operator",
        role: "maintainer"
      },
      environment: {
        workspaceRoot: root,
        interface: "mcp",
        backend: "codex"
      }
    });

    const consultation = await client.callTool({
      name: "oracle_ask",
      arguments: { question: "Who are you operating for?" }
    });
    expect(consultation.isError).not.toBe(true);
    expect(lastSystemPrompt).toContain("## Self-awareness");
    expect(lastSystemPrompt).toContain("Identity: Oracle.");
    expect(lastSystemPrompt).toContain("Operator: awareness-operator (maintainer).");
    expect(lastSystemPrompt).toContain(`Current workspace: ${path.basename(root)}.`);
    expect(lastSystemPrompt).not.toContain(`Current workspace: ${root}.`);
    expect(lastSystemPrompt).toContain("not a conscious being");
    expect(lastSystemPrompt).toContain("Boundaries:");
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
