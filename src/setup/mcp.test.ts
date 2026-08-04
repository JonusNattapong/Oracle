import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureProjectConfig, generateMcpSetup, writeMcpSetup } from "./mcp.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-setup-"));
  roots.push(root);
  return root;
}

describe("ensureProjectConfig", () => {
  test("creates project defaults only when config is absent", async () => {
    const root = await temporaryRoot();

    await ensureProjectConfig(root);
    const configPath = path.join(root, ".oracle", "config.json");
    const first = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, '{"model":"custom"}\n', "utf8");
    await ensureProjectConfig(root);

    expect(JSON.parse(first)).toMatchObject({ backend: "chatgpt-browser", model: "gpt-5.4" });
    expect(JSON.parse(first)).not.toHaveProperty("provider");
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe('{"model":"custom"}\n');
  });
});

describe("generateMcpSetup", () => {
  test("generates Claude Code project MCP JSON", () => {
    const root = path.resolve("project");
    const result = generateMcpSetup({ root, client: "claude-code", serverPath: path.resolve("dist/mcp.js") });
    expect(result.path).toBe(path.join(root, ".mcp.json"));
    expect(JSON.parse(result.content)).toMatchObject({
      mcpServers: {
        "oracle": {
          command: process.execPath,
          env: { ORACLE_WORKSPACE_ROOT: root }
        }
      }
    });
  });

  test("generates Codex project TOML", () => {
    const root = path.resolve("project");
    const result = generateMcpSetup({ root, client: "codex", serverPath: path.resolve("dist/mcp.js") });
    expect(result.path).toBe(path.join(root, ".codex", "config.toml"));
    expect(result.content).toContain('[mcp_servers.oracle]');
    expect(result.content).toContain("ORACLE_WORKSPACE_ROOT");
  });
});

describe("writeMcpSetup", () => {
  test("merges a Claude entry while preserving unrelated servers", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".mcp.json");
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { existing: { command: "existing" } } }));
    const generated = generateMcpSetup({ root, client: "claude-code", serverPath: path.join(root, "mcp.js") });

    await writeMcpSetup(generated);

    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      mcpServers: {
        existing: { command: "existing" },
        "oracle": expect.objectContaining({ command: process.execPath })
      }
    });
  });

  test("refuses a conflicting oracle entry unless forced", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".mcp.json");
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { "oracle": { command: "other" } } }));
    const generated = generateMcpSetup({ root, client: "claude-code", serverPath: path.join(root, "mcp.js") });

    await expect(writeMcpSetup(generated)).rejects.toMatchObject({ code: "ORACLE_CONFIG_INVALID" });
    await expect(writeMcpSetup(generated, true)).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcpServers["oracle"].command).toBe(process.execPath);
  });

  test("appends Codex configuration without replacing unrelated settings", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".codex", "config.toml");
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(configPath, 'model = "gpt-5.4"\n');
    const generated = generateMcpSetup({ root, client: "codex", serverPath: path.join(root, "mcp.js") });

    await writeMcpSetup(generated);

    const content = await fs.readFile(configPath, "utf8");
    expect(content).toContain('model = "gpt-5.4"');
    expect(content).toContain("[mcp_servers.oracle]");
  });
});
