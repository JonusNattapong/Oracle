import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../config/project.js";
import { OracleError } from "../errors.js";

export type McpClient = "claude-code" | "codex";

interface GenerateInput {
  root: string;
  client: McpClient;
  serverPath: string;
}

export interface SetupFile {
  path: string;
  content: string;
}

export async function ensureProjectConfig(root: string): Promise<string> {
  const configPath = path.join(path.resolve(root), ".oracle", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  try {
    await fs.access(configPath);
  } catch {
    const { provider: _legacyProvider, ...newConfig } = DEFAULT_PROJECT_CONFIG;
    await fs.writeFile(configPath, `${JSON.stringify(newConfig, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
  }
  return configPath;
}

function tomlString(value: string): string {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

export function generateMcpSetup(input: GenerateInput): SetupFile {
  const root = path.resolve(input.root);
  const serverPath = path.resolve(input.serverPath);
  if (input.client === "claude-code") {
    return {
      path: path.join(root, ".mcp.json"),
      content: `${JSON.stringify(
        {
          mcpServers: {
            "oracle": {
              command: process.execPath,
              args: [serverPath],
              env: { ORACLE_WORKSPACE_ROOT: root }
            }
          }
        },
        null,
        2
      )}\n`
    };
  }
  return {
    path: path.join(root, ".codex", "config.toml"),
    content: [
      "[mcp_servers.oracle]",
      `command = ${tomlString(process.execPath)}`,
      `args = [${tomlString(serverPath)}]`,
      "",
      "[mcp_servers.oracle.env]",
      `ORACLE_WORKSPACE_ROOT = ${tomlString(root)}`,
      ""
    ].join("\n")
  };
}

function conflict(filePath: string): OracleError {
  return new OracleError(
    "ORACLE_CONFIG_INVALID",
    `Mini Oracle MCP configuration already differs: ${filePath}`,
    "Review the existing oracle entry or rerun setup-mcp with --force."
  );
}

function mergeClaudeConfig(existing: string, generated: string, force: boolean, filePath: string): string {
  let current: { mcpServers?: Record<string, unknown> };
  try {
    current = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
  } catch {
    throw conflict(filePath);
  }
  const wanted = JSON.parse(generated) as { mcpServers: Record<string, unknown> };
  const currentEntry = current.mcpServers?.["oracle"];
  const wantedEntry = wanted.mcpServers["oracle"];
  if (currentEntry !== undefined && JSON.stringify(currentEntry) !== JSON.stringify(wantedEntry) && !force) {
    throw conflict(filePath);
  }
  return `${JSON.stringify(
    {
      ...current,
      mcpServers: { ...current.mcpServers, "oracle": wantedEntry }
    },
    null,
    2
  )}\n`;
}

function mergeCodexConfig(existing: string, generated: string, force: boolean, filePath: string): string {
  const marker = "[mcp_servers.oracle]";
  const lineEnding = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const markerLine = lines.findIndex((line) => line.trim() === marker);
  const generatedBlock = generated.trim().replaceAll("\n", lineEnding);
  if (markerLine < 0) return `${existing.trimEnd()}${lineEnding}${lineEnding}${generatedBlock}${lineEnding}`;

  // Replace only Oracle's table and its nested tables. The old implementation
  // replaced everything after the marker, which silently discarded unrelated
  // Codex settings when Oracle was not the final table in the file.
  let endLine = markerLine + 1;
  while (endLine < lines.length) {
    const table = lines[endLine].trim();
    const isTable = /^\[[^\]]+\]$/.test(table);
    const belongsToOracle = table.startsWith("[mcp_servers.oracle.");
    if (isTable && !belongsToOracle) break;
    endLine += 1;
  }
  const currentBlock = lines.slice(markerLine, endLine).join(lineEnding).trim();
  if (!force && currentBlock !== generatedBlock) throw conflict(filePath);

  const before = lines.slice(0, markerLine).join(lineEnding).trimEnd();
  const after = lines.slice(endLine).join(lineEnding).trimStart();
  return [before, generatedBlock, after].filter(Boolean).join(`${lineEnding}${lineEnding}`) + lineEnding;
}

export async function writeMcpSetup(file: SetupFile, force = false): Promise<void> {
  await fs.mkdir(path.dirname(file.path), { recursive: true });
  let content = file.content;
  try {
    const existing = await fs.readFile(file.path, "utf8");
    if (existing === file.content) return;
    content = file.path.endsWith(".json")
      ? mergeClaudeConfig(existing, file.content, force, file.path)
      : mergeCodexConfig(existing, file.content, force, file.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = `${file.path}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, file.path);
}
