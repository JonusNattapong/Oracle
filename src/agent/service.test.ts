import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProfileStore } from "../identity/profile.js";
import { AgentService } from "./service.js";
import type { AgentProvider } from "./types.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-agent-awareness-"));
  vi.stubEnv("ORACLE_HOME_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("AgentService awareness", () => {
  test("injects identity, operating mode, capabilities, and boundaries", async () => {
    await new ProfileStore(root).saveIdentity({
      name: "agent-operator",
      role: "maintainer"
    });

    let capturedSystem = "";
    const provider: AgentProvider = {
      id: "anthropic",
      async runAgentTurn(params) {
        capturedSystem = params.system;
        return {
          message: {
            role: "assistant",
            text: "done",
            toolCalls: []
          }
        };
      }
    };

    const service = new AgentService(provider);
    const result = await service.run({
      prompt: "Inspect the project",
      workspaceRoot: root,
      model: "test-model",
      readOnly: true,
      tools: [],
      maxSteps: 1,
      approvalMode: "off"
    });

    expect(result.finalText).toBe("done");
    expect(capturedSystem).toContain("## Self-awareness");
    expect(capturedSystem).toContain("Identity: Oracle.");
    expect(capturedSystem).toContain("Operator: agent-operator (maintainer).");
    expect(capturedSystem).toContain("Current interface: agent.");
    expect(capturedSystem).toContain("Current execution backend: anthropic.");
    expect(capturedSystem).toContain("Read-only mode: enabled.");
    expect(capturedSystem).toContain(`Current workspace: ${path.basename(root)}.`);
    expect(capturedSystem).not.toContain(`Current workspace: ${root}.`);
    expect(capturedSystem).toContain("Analyze workspace state without mutation");
    expect(capturedSystem).not.toContain("sentient AI");
    expect(capturedSystem).toContain("Capabilities:");
    expect(capturedSystem).toContain("Boundaries:");
  });
});
