import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BundleService } from "./bundleService.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bundle-test-"));
  roots.push(root);
  return root;
}

describe("BundleService", () => {
  test("creates a bundle with file content and manifest", async () => {
    const cwd = await createTempRoot();
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(path.join(cwd, "src", "main.ts"), 'console.log("hello world");');

    const service = new BundleService();
    const result = await service.createBundle({
      prompt: "Explain this code",
      files: ["src/**/*.ts"],
      cwd
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/main.ts");
    expect(result.bundle).toContain("hello world");
    expect(result.manifest).toHaveLength(1);
    expect(result.manifest[0].path).toBe("src/main.ts");
    expect(result.manifest[0].isImage).toBe(false);
  });

  test("detects secrets and throws ORACLE_SECRET_DETECTED", async () => {
    const cwd = await createTempRoot();
    await fs.writeFile(path.join(cwd, "secret.ts"), 'const apiKey = "sk-proj-1234567890123456789012345678901234567890";');

    const service = new BundleService();
    await expect(
      service.createBundle({
        prompt: "Review code",
        files: ["secret.ts"],
        cwd
      })
    ).rejects.toMatchObject({
      code: "ORACLE_SECRET_DETECTED"
    });
  });

  test("rejects input exceeding maxInputBytes", async () => {
    const cwd = await createTempRoot();
    await fs.writeFile(path.join(cwd, "large.txt"), "A".repeat(2000));

    const service = new BundleService();
    await expect(
      service.createBundle({
        prompt: "Review code",
        files: ["large.txt"],
        cwd,
        maxInputBytes: 500
      })
    ).rejects.toMatchObject({
      code: "ORACLE_INPUT_TOO_LARGE"
    });
  });
});
