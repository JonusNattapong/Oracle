import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
  ExecutionBackend,
  ExecutionBackendCapabilities,
  ExecutionBackendRequest
} from "../backends/backend.js";
import { FileSessionStore } from "../session/store.js";
import { ConsultService } from "./consult.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    )
  );
});

const BASE_CAPABILITIES: ExecutionBackendCapabilities = {
  consult: true,
  toolUse: false,
  images: true,
  continuation: true,
  structuredUsage: false,
  supportedPlatforms: ["win32", "darwin", "linux"]
};

function backendRecording(
  id: string,
  capabilities: Partial<ExecutionBackendCapabilities>,
  seen: ExecutionBackendRequest[]
): ExecutionBackend {
  return {
    id,
    capabilities: { ...BASE_CAPABILITIES, ...capabilities },
    async run(request) {
      seen.push(request);
      return { text: "ok", usage: {} };
    },
    healthCheck: async () => []
  };
}

async function serviceIn(backend: ExecutionBackend): Promise<{
  service: ConsultService;
  root: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-composer-tool-"));
  temporaryDirectories.push(root);
  return {
    service: new ConsultService(backend, new FileSessionStore(path.join(root, "home"))),
    root
  };
}

describe("ConsultService composer tools", () => {
  test("forwards the requested tool to a backend that supports composer tools", async () => {
    const seen: ExecutionBackendRequest[] = [];
    const { service, root } = await serviceIn(
      backendRecording("chatgpt-browser", { composerTools: true }, seen)
    );

    const result = await service.consult({
      prompt: "draw a cat",
      tool: "create-image",
      cwd: root,
      allowEmptyFiles: true
    });

    expect(result.status).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe("create-image");
  });

  test("refuses a composer tool the backend cannot engage instead of dropping it", async () => {
    // Without this guard the backend simply ignores `tool` and answers as
    // usual. The caller asked for a generated image and gets prose back with
    // nothing marking the request as unfulfilled.
    const seen: ExecutionBackendRequest[] = [];
    const { service, root } = await serviceIn(backendRecording("anthropic", {}, seen));

    // Rejected before a session is recorded, matching how an unsupported
    // accountMemory request is refused: nothing was sent, so nothing is logged.
    await expect(
      service.consult({
        prompt: "draw a cat",
        tool: "create-image",
        cwd: root,
        allowEmptyFiles: true
      })
    ).rejects.toThrow(/cannot engage the 'create-image' composer tool/);

    expect(seen).toHaveLength(0);
  });

  test("leaves toolless consults untouched on a backend without composer tools", async () => {
    const seen: ExecutionBackendRequest[] = [];
    const { service, root } = await serviceIn(backendRecording("anthropic", {}, seen));

    const result = await service.consult({
      prompt: "explain this",
      cwd: root,
      allowEmptyFiles: true
    });

    expect(result.status).toBe("completed");
    expect(seen[0].tool).toBeUndefined();
  });
});
