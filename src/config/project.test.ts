import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_PROJECT_CONFIG, loadProjectConfig } from "./project.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function rootWith(config?: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-"));
  roots.push(root);
  if (config !== undefined) {
    await fs.mkdir(path.join(root, ".oracle"));
    await fs.writeFile(path.join(root, ".oracle", "config.json"), JSON.stringify(config));
  }
  return root;
}

describe("loadProjectConfig", () => {
  test("uses immutable defaults when config is absent", async () => {
    const first = await loadProjectConfig(await rootWith());
    expect(first).toEqual(DEFAULT_PROJECT_CONFIG);
    first.include.push("mutated");
    expect((await loadProjectConfig(await rootWith())).include).not.toContain("mutated");
  });

  test("merges a valid partial config", async () => {
    const root = await rootWith({ model: "gpt-5.5", include: ["lib/**/*.ts"] });
    await expect(loadProjectConfig(root)).resolves.toMatchObject({
      backend: "codex",
      provider: "codex",
      model: "gpt-5.5",
      include: ["lib/**/*.ts"]
    });
  });

  test("supports backend key and legacy provider key migration", async () => {
    const rootBackend = await rootWith({ backend: "anthropic" });
    const configBackend = await loadProjectConfig(rootBackend);
    expect(configBackend.backend).toBe("anthropic");

    const rootProvider = await rootWith({ provider: "openai" });
    const configProvider = await loadProjectConfig(rootProvider);
    expect(configProvider.backend).toBe("openai");
    expect(configProvider.provider).toBe("openai");
  });

  test("loads experimental.browserMode flag", async () => {
    const root = await rootWith({
      experimental: { browserMode: true },
      browser: { timeoutMs: 60_000 }
    });
    const config = await loadProjectConfig(root);
    expect(config.experimental?.browserMode).toBe(true);
    expect(config.browser).toEqual({ timeoutMs: 60_000 });
  });

  test.each([
    [{ unknown: true }],
    [{ provider: "other" }],
    [{ model: "" }],
    [{ include: [] }],
    [{ maxFileSizeBytes: 0 }]
  ])("rejects invalid config %j", async (config) => {
    await expect(loadProjectConfig(await rootWith(config))).rejects.toMatchObject({
      code: "ORACLE_CONFIG_INVALID"
    });
  });
});
