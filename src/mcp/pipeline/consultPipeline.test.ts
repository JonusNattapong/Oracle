import { describe, expect, test } from "vitest";
import { DEFAULT_PROJECT_CONFIG } from "../../config/project.js";
import { ConsultService } from "../../core/consult.js";
import { MemoryAdapter } from "../../memory/adapter.js";
import { ProfileStore } from "../../identity/profile.js";
import type { Provider } from "../../providers/provider.js";
import type { ConsultRequest } from "../../types.js";
import { runConsultPipeline, type PipelineInput, type PipelineDeps } from "./consultPipeline.js";

/**
 * Regression test for the maxInputBytes drift bug.
 *
 * oracle_relay was built by copying oracle_ask, and the copy dropped
 * `maxFileSizeBytes` / `maxInputBytes` from its service.consult() call —
 * so the relay tool silently ignored the project's configured context
 * limits. After the pipeline refactor, service.consult() is called from
 * exactly one place (consultPipeline.ts stage 4), which always forwards
 * both limits. This test pins that guarantee so a future edit cannot
 * reintroduce the drift.
 */
describe("consult pipeline context limits", () => {
  const captured: ConsultRequest[] = [];

  const provider: Provider = {
    id: "codex",
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
      return { text: `ANSWER: ${request.userPrompt}`, usage: {} };
    },
  };

  const service = new ConsultService(provider, undefined, undefined, undefined, (id) => provider);
  // Capture what the pipeline forwards into consult().
  const originalConsult = service.consult.bind(service);
  service.consult = async (request) => {
    captured.push(request);
    return originalConsult(request);
  };

  const deps: PipelineDeps = {
    service,
    config: { ...DEFAULT_PROJECT_CONFIG, maxFileSizeBytes: 111_111, maxInputBytes: 222_222 },
    workspaceRoot: process.cwd(),
    providerId: "codex",
    memory: new MemoryAdapter(process.cwd(), ".oracle-memory-test-limits"),
    profile: new ProfileStore(process.cwd()),
    soulsDir: process.cwd(),
  };

  const input: PipelineInput = {
    prompt: "Does the pipeline forward context limits?",
    preset: "relay",
  };

  test("forwards maxFileSizeBytes and maxInputBytes into service.consult()", async () => {
    const outcome = await runConsultPipeline(input, deps);
    expect(outcome.isError).not.toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].maxFileSizeBytes).toBe(111_111);
    expect(captured[0].maxInputBytes).toBe(222_222);
  });

  test("forwards the selected ChatGPT research tool into service.consult()", async () => {
    captured.length = 0;
    const outcome = await runConsultPipeline({ ...input, webSearch: true }, deps);
    expect(outcome.isError).not.toBe(true);
    expect(captured[0].tool).toBe("web-search");

    captured.length = 0;
    const deepOutcome = await runConsultPipeline({ ...input, deepResearch: true }, deps);
    expect(deepOutcome.isError).not.toBe(true);
    expect(captured[0].tool).toBe("deep-research");
  });
});
