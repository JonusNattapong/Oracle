import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_PROJECT_CONFIG } from "../../config/project.js";
import { ConsultService } from "../../core/consult.js";
import { MemoryAdapter } from "../../memory/adapter.js";
import { ProfileStore } from "../../identity/profile.js";
import type { Provider } from "../../providers/provider.js";
import { FileSessionStore } from "../../session/store.js";
import type { AgentService } from "../../agent/service.js";
import { decideFlow, runFlow, type FlowDeps } from "./flow.js";

const roots: string[] = [];

const provider: Provider = {
  id: "chatgpt-browser",
  capabilities: {
    consult: true,
    toolUse: false,
    images: false,
    continuation: false,
    structuredUsage: false,
    supportedPlatforms: ["darwin", "linux", "win32"],
  },
  healthCheck: async () => [],
  async run(request) {
    lastTool = request.tool;
    lastPrompt = request.userPrompt;
    return { text: `ANSWER: ${request.userPrompt}`, usage: {} };
  },
};

let lastTool: string | undefined;
let lastPrompt = "";

async function makeDeps(agent?: AgentService): Promise<FlowDeps> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-flow-test-"));
  roots.push(root);
  return {
    service: new ConsultService(provider, new FileSessionStore(path.join(root, "sessions"))),
    config: { ...DEFAULT_PROJECT_CONFIG, include: [], exclude: [] },
    workspaceRoot: root,
    providerId: "chatgpt-browser",
    memory: new MemoryAdapter(root),
    profile: new ProfileStore(root),
    soulsDir: path.join(root, "souls"),
    agent,
    actionProvider: agent ? "codex" : undefined,
    agentUnavailableReason: "test backend unavailable",
  };
}

afterEach(async () => {
  lastTool = undefined;
  lastPrompt = "";
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe("Oracle flow controller", () => {
  test("classifies mutation requests as a plan in auto mode", () => {
    expect(decideFlow({ prompt: "Fix the auth bug" })).toMatchObject({ mode: "plan", requiresApproval: true });
    expect(decideFlow({ prompt: "What is the current Node release?" })).toMatchObject({ mode: "research", research: "web-search" });
    expect(decideFlow({ prompt: "Explain this function" })).toMatchObject({ mode: "consult" });
  });

  test("research mode forwards the selected ChatGPT research tool", async () => {
    const deps = await makeDeps();
    const result = await runFlow({ prompt: "Compare current options", mode: "research", research: "deep-research" }, deps);
    expect(result.isError).not.toBe(true);
    expect(lastTool).toBe("deep-research");
    expect(result.structuredContent.flow).toMatchObject({ mode: "research", status: "completed" });
  });

  test("action requests produce a plan until explicitly confirmed", async () => {
    const deps = await makeDeps();
    const result = await runFlow({ prompt: "Implement the new login flow", mode: "act" }, deps);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.flow).toMatchObject({ mode: "act", status: "approval_required", requiresApproval: true });
    expect(lastPrompt).toContain("Do not modify files");
  });

  test("confirmed actions hand off to the configured agent", async () => {
    const agent = { run: vi.fn().mockResolvedValue({
      finalText: "Implemented and verified.",
      steps: [{ turn: 1, text: "done", toolsUsed: ["edit_file"] }],
      stoppedOnLimit: false,
      usage: { inputTokens: 3, outputTokens: 4 },
      audit: { getSummary: () => ({ filesChanged: 1 }) },
    }) } as unknown as AgentService;
    const deps = await makeDeps(agent);
    const result = await runFlow({ prompt: "Implement the new login flow", mode: "act", confirm: true }, deps);
    expect(result.isError).not.toBe(true);
    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("Implement the new login flow") }));
    expect(result.structuredContent.flow).toMatchObject({ mode: "act", status: "completed", actionProvider: "codex", steps: 1 });
  });

  test("reports a handoff instead of pretending Browser Mode can mutate", async () => {
    const deps = await makeDeps();
    const result = await runFlow({ prompt: "Fix the auth bug", mode: "act", confirm: true }, deps);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.flow).toMatchObject({ mode: "act", status: "handoff_required" });
  });
});
