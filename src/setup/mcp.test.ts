import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureProjectConfig, generateMcpSetup, writeMcpSetup } from "./mcp.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
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

  test("generates Gemini CLI settings.json under mcpServers, same shape as Claude Code", () => {
    const root = path.resolve("project");
    const result = generateMcpSetup({ root, client: "gemini", serverPath: path.resolve("dist/mcp.js") });
    expect(result.path).toBe(path.join(root, ".gemini", "settings.json"));
    expect(JSON.parse(result.content)).toMatchObject({
      mcpServers: {
        "oracle": {
          command: process.execPath,
          args: [path.resolve("dist/mcp.js")],
          env: { ORACLE_WORKSPACE_ROOT: root }
        }
      }
    });
  });

  test("generates opencode.json with type/command-array/environment shape", () => {
    const root = path.resolve("project");
    const result = generateMcpSetup({ root, client: "opencode", serverPath: path.resolve("dist/mcp.js") });
    expect(result.path).toBe(path.join(root, "opencode.json"));
    expect(JSON.parse(result.content)).toMatchObject({
      mcp: {
        "oracle": {
          type: "local",
          command: [process.execPath, path.resolve("dist/mcp.js")],
          enabled: true,
          environment: { ORACLE_WORKSPACE_ROOT: root }
        }
      }
    });
  });

  test("generates openclaw.json nested under mcp.servers", () => {
    const root = path.resolve("project");
    const result = generateMcpSetup({ root, client: "openclaw", serverPath: path.resolve("dist/mcp.js") });
    expect(result.path).toBe(path.join(root, "openclaw.json"));
    expect(JSON.parse(result.content)).toMatchObject({
      mcp: {
        servers: {
          "oracle": {
            command: process.execPath,
            args: [path.resolve("dist/mcp.js")],
            env: { ORACLE_WORKSPACE_ROOT: root }
          }
        }
      }
    });
  });

  test("generates Hermes Agent's global YAML config, not a project-relative file", () => {
    const root = path.resolve("project");
    const homeDir = path.resolve("fake-home");
    const result = generateMcpSetup({ root, client: "hermes", serverPath: path.resolve("dist/mcp.js"), homeDir });
    expect(result.path).toBe(path.join(homeDir, ".hermes", "config.yaml"));
    expect(result.content).toContain("mcp_servers:");
    expect(result.content).toContain("  oracle:");
    expect(result.content).toContain(`command: ${JSON.stringify(process.execPath.replaceAll("\\", "/"))}`);
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

  test("merges opencode.json under mcp while preserving unrelated servers and top-level keys", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, "opencode.json");
    await fs.writeFile(configPath, JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      mcp: { existing: { type: "local", command: ["existing"] } }
    }));
    const generated = generateMcpSetup({ root, client: "opencode", serverPath: path.join(root, "mcp.js") });

    await writeMcpSetup(generated);

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written["$schema"]).toBe("https://opencode.ai/config.json");
    expect(written.mcp.existing).toMatchObject({ type: "local", command: ["existing"] });
    expect(written.mcp["oracle"]).toMatchObject({ type: "local", enabled: true });
  });

  test("merges openclaw.json two levels deep (mcp.servers) without disturbing mcp.<other keys>", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({
      mcp: { servers: { existing: { command: "existing" } }, someOtherSetting: true }
    }));
    const generated = generateMcpSetup({ root, client: "openclaw", serverPath: path.join(root, "mcp.js") });

    await writeMcpSetup(generated);

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.mcp.someOtherSetting).toBe(true);
    expect(written.mcp.servers.existing).toMatchObject({ command: "existing" });
    expect(written.mcp.servers["oracle"]).toMatchObject({ command: process.execPath });
  });

  test("merges Gemini settings.json under mcpServers while preserving unrelated settings", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".gemini", "settings.json");
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(configPath, JSON.stringify({
      theme: "dark",
      mcpServers: { existing: { command: "existing" } }
    }));
    const generated = generateMcpSetup({ root, client: "gemini", serverPath: path.join(root, "mcp.js") });

    await writeMcpSetup(generated);

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.existing).toMatchObject({ command: "existing" });
    expect(written.mcpServers["oracle"]).toMatchObject({ command: process.execPath });
  });

  test("appends Hermes YAML config without an existing mcp_servers section", async () => {
    const root = await temporaryRoot();
    const homeDir = await temporaryRoot();
    const configPath = path.join(homeDir, ".hermes", "config.yaml");
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(configPath, "log_level: info\n");
    const generated = generateMcpSetup({ root, client: "hermes", serverPath: path.join(root, "mcp.js"), homeDir });

    await writeMcpSetup(generated);

    const content = await fs.readFile(configPath, "utf8");
    expect(content).toContain("log_level: info");
    expect(content).toContain("mcp_servers:");
    expect(content).toContain("  oracle:");
    expect(content).toContain("ORACLE_WORKSPACE_ROOT");
  });

  test("adds oracle under an existing mcp_servers section without disturbing sibling servers", async () => {
    const root = await temporaryRoot();
    const homeDir = await temporaryRoot();
    const configPath = path.join(homeDir, ".hermes", "config.yaml");
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(
      configPath,
      [
        "log_level: info",
        "mcp_servers:",
        "  filesystem:",
        '    command: "npx"',
        "    args:",
        '      - "-y"',
        ""
      ].join("\n")
    );
    const generated = generateMcpSetup({ root, client: "hermes", serverPath: path.join(root, "mcp.js"), homeDir });

    await writeMcpSetup(generated);

    const content = await fs.readFile(configPath, "utf8");
    expect(content).toContain("  filesystem:");
    expect(content).toContain('command: "npx"');
    expect(content).toContain("  oracle:");
    expect(content).toContain("ORACLE_WORKSPACE_ROOT");
  });

  test("replaces only the oracle block in Hermes YAML, preserving sibling servers", async () => {
    const root = await temporaryRoot();
    const homeDir = await temporaryRoot();
    const configPath = path.join(homeDir, ".hermes", "config.yaml");
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(
      configPath,
      [
        "mcp_servers:",
        "  oracle:",
        '    command: "old-node"',
        "    args:",
        '      - "old-mcp.js"',
        "    env:",
        '      ORACLE_WORKSPACE_ROOT: "old-root"',
        "  filesystem:",
        '    command: "npx"',
        ""
      ].join("\n")
    );
    const generated = generateMcpSetup({ root, client: "hermes", serverPath: path.join(root, "mcp.js"), homeDir });

    await writeMcpSetup(generated, true);

    const content = await fs.readFile(configPath, "utf8");
    expect(content).not.toContain("old-root");
    expect(content).not.toContain("old-node");
    expect(content).toContain("  filesystem:");
    expect(content).toContain('command: "npx"');
    expect(content).toContain(root.replaceAll("\\", "/"));
  });

  test("replaces only the Oracle Codex block and preserves later tables", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".codex", "config.toml");
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(
      configPath,
      [
        'model = "gpt-5.4"',
        "",
        "[mcp_servers.oracle]",
        'command = "old-node"',
        'args = ["old-mcp.js"]',
        "",
        "[mcp_servers.oracle.env]",
        'ORACLE_WORKSPACE_ROOT = "old-root"',
        "",
        "[profiles.review]",
        'model = "gpt-5.6"',
        "",
      ].join("\n"),
      "utf8"
    );
    const generated = generateMcpSetup({ root, client: "codex", serverPath: path.join(root, "mcp.js") });

    await writeMcpSetup(generated, true);

    const content = await fs.readFile(configPath, "utf8");
    expect(content).toContain('[profiles.review]');
    expect(content).toContain('model = "gpt-5.6"');
    expect(content).toContain(`args = [${JSON.stringify(path.join(root, "mcp.js").replaceAll("\\", "/"))}]`);
    expect(content).not.toContain('ORACLE_WORKSPACE_ROOT = "old-root"');
  });
});
