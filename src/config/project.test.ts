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
    const root = await rootWith({
      provider: "auto",
      include: ["lib/**/*.ts"],
      browser: { remoteChrome: "127.0.0.1:9222" },
      worker: { heartbeat: "5s" },
      azure: {
        endpoint: "https://company.openai.azure.com",
        deployment: "company-gpt"
      },
      openrouter: { appName: "Team Oracle" },
      routing: { defaultProvider: "browser", preferAzure: true },
      serve: { host: "0.0.0.0", port: 9474, manualLogin: false }
    });
    await expect(loadProjectConfig(root)).resolves.toMatchObject({
      provider: "auto",
      include: ["lib/**/*.ts"],
      browser: {
        model: "gpt-5.6-sol",
        remoteChrome: "127.0.0.1:9222",
        timeout: "30m"
      },
      worker: { heartbeat: "5s", maxAttempts: 3 },
      azure: {
        endpoint: "https://company.openai.azure.com",
        deployment: "company-gpt"
      },
      openrouter: {
        baseURL: "https://openrouter.ai/api/v1",
        appName: "Team Oracle"
      },
      routing: { defaultProvider: "browser", preferAzure: true },
      serve: { host: "0.0.0.0", port: 9474, manualLogin: false }
    });
  });

  test.each([
    [{ unknown: true }],
    [{ provider: "other" }],
    [{ model: "" }],
    [{ include: [] }],
    [{ maxFileSizeBytes: 0 }],
    [{ browser: { unknown: true } }],
    [{ worker: { maxAttempts: 0 } }],
    [{ azure: { endpoint: "not-a-url" } }],
    [{ openrouter: { unknown: true } }],
    [{ routing: { defaultProvider: "auto" } }],
    [{ serve: { port: 70_000 } }]
  ])("rejects invalid config %j", async (config) => {
    await expect(loadProjectConfig(await rootWith(config))).rejects.toMatchObject({
      code: "ORACLE_CONFIG_INVALID"
    });
  });
});
