import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveFiles } from "./files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    )
  );
});

async function createWorkspace(): Promise<{ root: string; outsideFile: string }> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-"));
  temporaryDirectories.push(temporaryRoot);
  const root = path.join(temporaryRoot, "workspace");
  const outsideFile = path.join(temporaryRoot, "outside.txt");
  await fs.mkdir(root);
  await fs.writeFile(outsideFile, "secret", "utf8");
  return { root, outsideFile };
}

describe("resolveFiles", () => {
  test("rejects parent traversal outside cwd", async () => {
    const { root } = await createWorkspace();

    await expect(resolveFiles(["../outside.txt"], { cwd: root })).rejects.toThrow(
      "outside the working directory"
    );
  });

  test("rejects absolute paths outside cwd", async () => {
    const { root, outsideFile } = await createWorkspace();

    await expect(resolveFiles([outsideFile], { cwd: root })).rejects.toThrow(
      "outside the working directory"
    );
  });
});
