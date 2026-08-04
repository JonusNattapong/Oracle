import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileSessionStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    )
  );
});

describe("FileSessionStore", () => {
  test("creates a session in a new home directory", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-"));
    temporaryDirectories.push(temporaryRoot);
    const homeDir = path.join(temporaryRoot, "oracle-home");
    const store = new FileSessionStore(homeDir);

    const record = await store.create({
      id: "first-session",
      cwd: temporaryRoot,
      prompt: "Review this project",
      model: "test-model",
      files: [],
      bundle: "bundle"
    });

    expect(record.sessionId).toBe("first-session");
    await expect(
      fs.readFile(path.join(homeDir, "sessions", "first-session", "bundle.md"), "utf8")
    ).resolves.toBe("bundle");
  });
});
