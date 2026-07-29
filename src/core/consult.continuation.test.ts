import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ExecutionBackend,
  ExecutionBackendRequest
} from "../backends/backend.js";
import { FileSessionStore } from "../session/store.js";
import { ConsultService } from "./consult.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe("ConsultService conversation continuation", () => {
  test("persists only session-contained image artifacts from a backend", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-image-session-"));
    temporaryDirectories.push(root);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const backend: ExecutionBackend = {
      id: "chatgpt-browser",
      capabilities: {
        consult: true,
        toolUse: false,
        images: true,
        continuation: true,
        structuredUsage: false,
        supportedPlatforms: ["win32"]
      },
      async run(request) {
        const outputDir = path.join(request.artifactsDir!, "images");
        await fs.mkdir(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, "output-001.png");
        await fs.writeFile(outputPath, png);
        return {
          text: "diagram",
          usage: {},
          images: [{
            path: outputPath,
            mimeType: "image/png",
            sizeBytes: png.length,
            fileName: "output-001.png"
          }]
        };
      },
      healthCheck: async () => []
    };
    const service = new ConsultService(
      backend,
      new FileSessionStore(path.join(root, "home"))
    );

    const result = await service.consult({
      prompt: "draw it",
      cwd: root,
      allowEmptyFiles: true
    });

    expect(result.status).toBe("completed");
    expect(result.images).toEqual([
      expect.objectContaining({
        mimeType: "image/png",
        fileName: "output-001.png"
      })
    ]);
    expect(path.relative(path.dirname(result.images![0].path), result.images![0].path))
      .toBe("output-001.png");
  });

  test("rejects backend artifacts that escape the session directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-image-session-"));
    temporaryDirectories.push(root);
    const outsidePath = path.join(root, "outside.png");
    await fs.writeFile(outsidePath, "outside");
    const backend: ExecutionBackend = {
      id: "chatgpt-browser",
      capabilities: {
        consult: true,
        toolUse: false,
        images: true,
        continuation: true,
        structuredUsage: false,
        supportedPlatforms: ["win32"]
      },
      async run(request) {
        await fs.mkdir(request.artifactsDir!, { recursive: true });
        return {
          text: "bad artifact",
          usage: {},
          images: [{
            path: outsidePath,
            mimeType: "image/png",
            sizeBytes: 7,
            fileName: "outside.png"
          }]
        };
      },
      healthCheck: async () => []
    };
    const service = new ConsultService(
      backend,
      new FileSessionStore(path.join(root, "home"))
    );

    const result = await service.consult({
      prompt: "draw it",
      cwd: root,
      allowEmptyFiles: true
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/escaped the session artifact directory/i);
  });

  test("rejects account memory on a backend without that capability", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-account-memory-"));
    temporaryDirectories.push(root);
    const run = vi.fn();
    const backend: ExecutionBackend = {
      id: "codex",
      capabilities: {
        consult: true,
        toolUse: false,
        images: false,
        continuation: false,
        structuredUsage: false,
        supportedPlatforms: ["win32"]
      },
      run,
      healthCheck: async () => []
    };
    const service = new ConsultService(
      backend,
      new FileSessionStore(path.join(root, "home"))
    );

    await expect(service.consult({
      prompt: "answer normally",
      accountMemory: "Prefers concise answers",
      cwd: root,
      allowEmptyFiles: true
    })).rejects.toMatchObject({ code: "ORACLE_ACCOUNT_MEMORY_UNSUPPORTED" });
    expect(run).not.toHaveBeenCalled();
  });

  test("passes account memory separately and persists only status metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-account-memory-"));
    temporaryDirectories.push(root);
    const run = vi.fn(async () => ({
      text: "answer",
      usage: {},
      accountMemorySaved: true
    }));
    const backend: ExecutionBackend = {
      id: "chatgpt-browser",
      capabilities: {
        consult: true,
        toolUse: false,
        images: false,
        continuation: true,
        accountMemory: true,
        structuredUsage: false,
        supportedPlatforms: ["win32"]
      },
      run,
      healthCheck: async () => []
    };
    const sessions = new FileSessionStore(path.join(root, "home"));
    const service = new ConsultService(backend, sessions);

    const result = await service.consult({
      prompt: "answer normally",
      accountMemory: "Prefers concise answers",
      cwd: root,
      allowEmptyFiles: true
    });
    const stored = await sessions.read(result.sessionId);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      userPrompt: expect.not.stringContaining("Prefers concise answers"),
      accountMemory: "Prefers concise answers"
    }));
    expect(result).toMatchObject({
      accountMemoryRequested: true,
      accountMemorySaved: true
    });
    expect(JSON.stringify(stored)).not.toContain("Prefers concise answers");
  });

  test("blocks potential secrets before writing account memory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-account-memory-"));
    temporaryDirectories.push(root);
    const run = vi.fn();
    const backend: ExecutionBackend = {
      id: "chatgpt-browser",
      capabilities: {
        consult: true,
        toolUse: false,
        images: false,
        continuation: true,
        accountMemory: true,
        structuredUsage: false,
        supportedPlatforms: ["win32"]
      },
      run,
      healthCheck: async () => []
    };
    const service = new ConsultService(
      backend,
      new FileSessionStore(path.join(root, "home"))
    );

    await expect(service.consult({
      prompt: "answer normally",
      accountMemory: "api_key = sk-proj-123456789012345678901234567890",
      cwd: root,
      allowEmptyFiles: true
    })).rejects.toMatchObject({ code: "ORACLE_SECRET_DETECTED" });
    expect(run).not.toHaveBeenCalled();
  });

  test("resumes the latest response for the same backend and conversation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-continuation-"));
    temporaryDirectories.push(root);
    const run = vi.fn(async (request: ExecutionBackendRequest) => ({
      responseId: request.previousResponseId ?? "https://chatgpt.com/c/native-chat-1",
      text: request.previousResponseId ? "second" : "first",
      usage: {}
    }));
    const backend: ExecutionBackend = {
      id: "chatgpt-browser",
      capabilities: {
        consult: true,
        toolUse: false,
        images: false,
        continuation: true,
        structuredUsage: false,
        supportedPlatforms: ["win32"]
      },
      run,
      healthCheck: async () => []
    };
    const service = new ConsultService(
      backend,
      new FileSessionStore(path.join(root, "home"))
    );

    const first = await service.consult({
      prompt: "first question",
      conversationId: "architecture-review",
      cwd: root,
      allowEmptyFiles: true
    });
    const second = await service.consult({
      prompt: "follow-up question",
      conversationId: "architecture-review",
      cwd: root,
      allowEmptyFiles: true
    });

    expect(first.responseId).toBe("https://chatgpt.com/c/native-chat-1");
    expect(second.conversationId).toBe("architecture-review");
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        previousResponseId: "https://chatgpt.com/c/native-chat-1"
      })
    );
  });

  test("does not continue a different logical conversation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-continuation-"));
    temporaryDirectories.push(root);
    const run = vi.fn(async () => ({
      responseId: "https://chatgpt.com/c/native-chat-2",
      text: "answer",
      usage: {}
    }));
    const backend: ExecutionBackend = {
      id: "chatgpt-browser",
      capabilities: {
        consult: true,
        toolUse: false,
        images: false,
        continuation: true,
        structuredUsage: false,
        supportedPlatforms: ["win32"]
      },
      run,
      healthCheck: async () => []
    };
    const service = new ConsultService(
      backend,
      new FileSessionStore(path.join(root, "home"))
    );

    await service.consult({
      prompt: "one",
      conversationId: "conversation-one",
      cwd: root,
      allowEmptyFiles: true
    });
    await service.consult({
      prompt: "two",
      conversationId: "conversation-two",
      cwd: root,
      allowEmptyFiles: true
    });

    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ previousResponseId: undefined })
    );
  });
});
