import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runAgentLoop } from "./loop.js";
import { CheckpointStore } from "./checkpoint.js";
import { defaultAgentTools } from "./tools.js";
import type { AgentApprovalGate } from "./approvalGate.js";
import { approvalPayloadHash } from "../control/payload.js";
import type { ApprovalRequest } from "../control/types.js";
import type { AgentProvider, AgentTool, AgentTurn } from "./types.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-agent-loop-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Scripted provider: returns a queued turn each call. Lets us drive the loop
 * deterministically without a real model, verifying tool execution + feedback.
 */
function scriptedProvider(turns: AgentTurn[]): AgentProvider & { calls: number } {
  const provider = {
    id: "scripted",
    calls: 0,
    async runAgentTurn(): Promise<AgentTurn> {
      const turn = turns[provider.calls];
      provider.calls += 1;
      if (!turn) throw new Error("scripted provider ran out of turns");
      return turn;
    },
  };
  return provider;
}

describe("runAgentLoop", () => {
  test("executes a tool call then returns the final text", async () => {
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "Writing the file.",
          toolCalls: [{ id: "c1", name: "write_file", input: { path: "hello.txt", content: "hi" } }],
        },
      },
      { message: { role: "assistant", text: "Done — created hello.txt.", toolCalls: [] } },
    ]);

    const result = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "create hello.txt",
      tools: defaultAgentTools(),
      context: { workspaceRoot: root, readOnly: false },
    });

    expect(provider.calls).toBe(2);
    expect(result.finalText).toBe("Done — created hello.txt.");
    expect(result.stoppedOnLimit).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].toolsUsed).toEqual(["write_file"]);
    // The file was actually written by the tool during the loop.
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("hi");
  });

  test("feeds tool errors back to the model instead of throwing", async () => {
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "read_file", input: { path: "missing.txt" } }],
        },
      },
      { message: { role: "assistant", text: "That file does not exist.", toolCalls: [] } },
    ]);

    const result = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "read missing.txt",
      tools: defaultAgentTools(),
      context: { workspaceRoot: root, readOnly: false },
    });

    expect(result.finalText).toBe("That file does not exist.");
    const toolMsg = result.transcript.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (toolMsg?.role === "tool") expect(toolMsg.results[0].isError).toBe(true);
  });

  test("stops at maxSteps when the model keeps calling tools", async () => {
    const loopingTurn: AgentTurn = {
      message: {
        role: "assistant",
        text: "still working",
        toolCalls: [{ id: "c", name: "list_dir", input: {} }],
      },
    };
    const provider = scriptedProvider([loopingTurn, loopingTurn, loopingTurn]);

    const result = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "loop forever",
      tools: defaultAgentTools(),
      context: { workspaceRoot: root, readOnly: false },
      maxSteps: 3,
    });

    expect(result.stoppedOnLimit).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(provider.calls).toBe(3);
  });

  test("reports an unknown tool back to the model", async () => {
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "no_such_tool", input: {} }],
        },
      },
      { message: { role: "assistant", text: "ok", toolCalls: [] } },
    ]);

    const result = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "x",
      tools: defaultAgentTools(),
      context: { workspaceRoot: root, readOnly: false },
    });

    const toolMsg = result.transcript.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      const contentText = toolMsg.results[0].content
        .filter((c) => c.type === "text")
        .map((c) => (c as any).text)
        .join("");
      expect(contentText).toContain("Unknown tool");
      expect(toolMsg.results[0].isError).toBe(true);
    }
  });

  test("persists audit records and enforces the mutation limit", async () => {
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "",
          toolCalls: [
            { id: "c1", name: "write_file", input: { path: "one.txt", content: "one" } },
            { id: "c2", name: "write_file", input: { path: "two.txt", content: "two" } }
          ],
        },
      },
      { message: { role: "assistant", text: "Stopped after the policy denial.", toolCalls: [] } },
    ]);

    await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "write two files",
      tools: defaultAgentTools(),
      context: {
        workspaceRoot: root,
        readOnly: false,
        policy: {
          forbiddenGlobs: [],
          forbiddenCommands: [],
          maxMutationsPerSession: 1
        }
      },
    });

    expect(await fs.readFile(path.join(root, "one.txt"), "utf8")).toBe("one");
    await expect(fs.readFile(path.join(root, "two.txt"), "utf8")).rejects.toThrow();

    const auditLines = (await fs.readFile(path.join(root, ".oracle", "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; target: string; details?: { rule?: string } });
    expect(auditLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "write", target: "one.txt" }),
      expect.objectContaining({
        action: "policy_denied",
        target: "two.txt",
        details: expect.objectContaining({ rule: "max_mutations_per_session" })
      })
    ]));
  });

  test("pauses a risky tool, resumes after approval, and claims execution once", async () => {
    let toolExecutions = 0;
    let claims = 0;
    let completions = 0;
    let approval: ApprovalRequest | undefined;
    const dangerousTool: AgentTool = {
      name: "bash",
      description: "test command",
      mutating: true,
      inputSchema: { type: "object" },
      async execute() {
        toolExecutions++;
        return "pushed";
      }
    };
    const gate: AgentApprovalGate = {
      assess: () => ({ risk: "high", reason: "publishes commits" }),
      async request(input) {
        const action = {
          type: "agent.tool",
          payload: {
            toolName: input.call.name,
            input: input.call.input,
            workspaceRoot: input.workspaceRoot
          }
        };
        approval = {
          id: "approval-test",
          kind: "command",
          title: "Push",
          requestedBy: "scripted",
          assignedTo: "lead",
          authorizedReviewers: ["lead"],
          risk: "high",
          status: "pending",
          version: 1,
          requiredApprovals: 1,
          approvalCount: 0,
          payloadHash: approvalPayloadHash(action),
          action,
          checkpointId: input.checkpointId,
          localOnly: true,
          votes: [],
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        return approval;
      },
      async get() {
        return approval ?? null;
      },
      async claim(current) {
        claims++;
        return {
          approval: current,
          execution: {
            id: "execution-test",
            approvalId: current.id,
            payloadHash: current.payloadHash!,
            status: "claimed",
            claimedBy: "scripted",
            claimedAt: new Date().toISOString()
          }
        };
      },
      async complete() {
        completions++;
      }
    };
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "Ready to push.",
          toolCalls: [{
            id: "danger-1",
            name: "bash",
            input: { command: "git push origin main" }
          }]
        }
      },
      {
        message: {
          role: "assistant",
          text: "Push completed.",
          toolCalls: []
        }
      }
    ]);
    const checkpoints = new CheckpointStore(path.join(root, "checkpoints"));
    const first = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "push",
      tools: [dangerousTool],
      context: { workspaceRoot: root, readOnly: false },
      checkpointStore: checkpoints,
      approvalGate: gate
    });

    expect(first.waitingForApproval).toMatchObject({
      approvalId: "approval-test",
      risk: "high"
    });
    expect(toolExecutions).toBe(0);
    expect(provider.calls).toBe(1);

    approval = {
      ...approval!,
      status: "approved",
      version: 2,
      approvalCount: 1,
      decidedAt: new Date().toISOString(),
      decidedBy: "lead"
    };
    const resumed = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "push",
      tools: [dangerousTool],
      context: { workspaceRoot: root, readOnly: false },
      checkpointStore: checkpoints,
      resumeCheckpointId: first.checkpointId,
      approvalGate: gate
    });

    expect(resumed.finalText).toBe("Push completed.");
    expect(resumed.waitingForApproval).toBeUndefined();
    expect(toolExecutions).toBe(1);
    expect(claims).toBe(1);
    expect(completions).toBe(1);
  });

  test("fails closed when an approval gate is used without checkpoint persistence", async () => {
    let executed = false;
    const tool: AgentTool = {
      name: "bash",
      description: "dangerous",
      mutating: true,
      inputSchema: { type: "object" },
      async execute() {
        executed = true;
        return "unexpected";
      }
    };
    const gate: AgentApprovalGate = {
      assess: () => ({ risk: "high", reason: "dangerous" }),
      async request() { throw new Error("should not request"); },
      async get() { return null; },
      async claim() { throw new Error("should not claim"); },
      async complete() {}
    };
    const provider = scriptedProvider([{
      message: {
        role: "assistant",
        text: "",
        toolCalls: [{
          id: "danger-no-checkpoint",
          name: "bash",
          input: { command: "git push" }
        }]
      }
    }]);

    await expect(runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "push",
      tools: [tool],
      context: { workspaceRoot: root, readOnly: false },
      approvalGate: gate
    })).rejects.toThrow(/without checkpoint persistence/);
    expect(executed).toBe(false);
  });
});
