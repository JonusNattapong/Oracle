import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../config/project.js";
import { OracleError } from "../errors.js";

export type McpClient = "claude-code" | "codex" | "opencode" | "gemini" | "openclaw" | "hermes";

export const MCP_CLIENTS: readonly McpClient[] = [
  "claude-code",
  "codex",
  "opencode",
  "gemini",
  "openclaw",
  "hermes"
];

interface GenerateInput {
  root: string;
  client: McpClient;
  serverPath: string;
  /** Overridable for tests — the `hermes` client's config lives outside the project root, at `<homeDir>/.hermes/config.yaml`. */
  homeDir?: string;
}

export interface SetupFile {
  path: string;
  content: string;
  /** "json" | "toml" | "yaml" — decides which merge strategy writeMcpSetup uses. */
  format: "json" | "toml" | "yaml";
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

/**
 * Builds the JSON value for the object at `serverPath` in a client's config
 * — e.g. `{ mcpServers: { oracle: {...} } }` for clients whose servers live
 * directly under `mcpServers`, or a deeper nest for clients like OpenClaw
 * (`mcp.servers.oracle`). `serverPath` is also threaded through to
 * `mergeJsonConfig` so a write only ever touches this one nested object,
 * never anything else already in the user's config file.
 */
function nestJson(serverPath: string[], entry: Record<string, unknown>): Record<string, unknown> {
  return serverPath.reduceRight<Record<string, unknown>>(
    (inner, key) => ({ [key]: inner }),
    { "oracle": entry }
  );
}

/**
 * Each client discovers MCP servers by reading its own config file in its own
 * shape — same underlying `oracle.js` process, six different envelopes.
 * Schemas verified against each project's own docs (2026-08-07), not guessed:
 * getting a field name wrong here doesn't fail loudly, it silently produces a
 * config the client never loads Oracle from.
 */
export function generateMcpSetup(input: GenerateInput): SetupFile {
  const root = path.resolve(input.root);
  const serverPath = path.resolve(input.serverPath);
  const command = process.execPath;

  switch (input.client) {
    case "claude-code":
      return jsonSetupFile(
        path.join(root, ".mcp.json"),
        ["mcpServers"],
        { command, args: [serverPath], env: { ORACLE_WORKSPACE_ROOT: root } }
      );

    case "gemini":
      // Same mcpServers-at-top-level shape as Claude Code, different file —
      // .gemini/settings.json also holds unrelated Gemini CLI settings, so
      // the merge (not just the shape) has to leave those alone too.
      return jsonSetupFile(
        path.join(root, ".gemini", "settings.json"),
        ["mcpServers"],
        { command, args: [serverPath], env: { ORACLE_WORKSPACE_ROOT: root } }
      );

    case "opencode":
      // opencode.json uses "mcp" (not "mcpServers"), command as an array
      // rather than command+args, "environment" (not "env"), and requires
      // type: "local" to mark this as a stdio server rather than remote.
      return jsonSetupFile(
        path.join(root, "opencode.json"),
        ["mcp"],
        {
          type: "local",
          command: [command, serverPath],
          enabled: true,
          environment: { ORACLE_WORKSPACE_ROOT: root }
        }
      );

    case "openclaw":
      // openclaw.json nests one level deeper: mcp.servers.oracle, not
      // mcp.oracle — the "servers" level is where mcporter and the CLI's
      // own `openclaw mcp set` write to, and where `openclaw mcp list`
      // reads from.
      return jsonSetupFile(
        path.join(root, "openclaw.json"),
        ["mcp", "servers"],
        { command, args: [serverPath], env: { ORACLE_WORKSPACE_ROOT: root } }
      );

    case "hermes":
      // Hermes Agent's own config is not project-scoped like the other five
      // — every source consulted for this only documents a single global
      // file, ~/.hermes/config.yaml. That means this is the one client
      // where `oracle setup-mcp` writes outside the project root.
      return {
        path: path.join(input.homeDir ?? os.homedir(), ".hermes", "config.yaml"),
        format: "yaml",
        content: [
          "mcp_servers:",
          "  oracle:",
          `    command: ${yamlString(command)}`,
          "    args:",
          `      - ${yamlString(serverPath)}`,
          "    env:",
          `      ORACLE_WORKSPACE_ROOT: ${yamlString(root)}`,
          ""
        ].join("\n")
      };

    case "codex":
    default:
      return {
        path: path.join(root, ".codex", "config.toml"),
        format: "toml",
        content: [
          "[mcp_servers.oracle]",
          `command = ${tomlString(command)}`,
          `args = [${tomlString(serverPath)}]`,
          "",
          "[mcp_servers.oracle.env]",
          `ORACLE_WORKSPACE_ROOT = ${tomlString(root)}`,
          ""
        ].join("\n")
      };
  }
}

function jsonSetupFile(filePath: string, serverPath: string[], entry: Record<string, unknown>): SetupFile {
  return {
    path: filePath,
    format: "json",
    content: `${JSON.stringify(nestJson(serverPath, entry), null, 2)}\n`
  };
}

function yamlString(value: string): string {
  // Double-quoted scalar: valid for any of the plain paths/executables this
  // generates, and JSON.stringify's escaping rules are a strict subset of
  // YAML's for double-quoted strings, so reusing it is exact rather than
  // approximate.
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function conflict(filePath: string): OracleError {
  return new OracleError(
    "ORACLE_CONFIG_INVALID",
    `Mini Oracle MCP configuration already differs: ${filePath}`,
    "Review the existing oracle entry or rerun setup-mcp with --force."
  );
}

/** Reads the object at `path` inside `obj`, treating a missing intermediate key as an empty object. */
function getIn(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  let cursor: unknown = obj;
  for (const key of keys) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor as Record<string, unknown> | undefined;
}

/** Returns a copy of `obj` with `value` set at the nested `keys` path, creating intermediate objects as needed. */
function setIn(
  obj: Record<string, unknown>,
  keys: string[],
  value: unknown
): Record<string, unknown> {
  if (keys.length === 0) return value as Record<string, unknown>;
  const [head, ...rest] = keys;
  const existingChild = obj[head];
  const child = typeof existingChild === "object" && existingChild !== null
    ? existingChild as Record<string, unknown>
    : {};
  return { ...obj, [head]: setIn(child, rest, value) };
}

/**
 * Merges the `oracle` entry into whichever JSON path this client's servers
 * live at (`mcpServers`, `mcp`, or `mcp.servers`), leaving every other key in
 * the file — including other MCP servers at the same level — untouched.
 */
function mergeJsonConfig(
  existing: string,
  generated: string,
  force: boolean,
  filePath: string,
  serversPath: string[]
): string {
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    throw conflict(filePath);
  }
  const wanted = JSON.parse(generated) as Record<string, unknown>;
  const wantedEntry = getIn(wanted, serversPath)?.["oracle"];
  const currentEntry = getIn(current, serversPath)?.["oracle"];
  if (currentEntry !== undefined && JSON.stringify(currentEntry) !== JSON.stringify(wantedEntry) && !force) {
    throw conflict(filePath);
  }
  const currentServers = getIn(current, serversPath) ?? {};
  const merged = setIn(current, serversPath, { ...currentServers, "oracle": wantedEntry });
  return `${JSON.stringify(merged, null, 2)}\n`;
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

/**
 * Same splice technique as `mergeCodexConfig`, adapted to YAML's
 * indentation-delimited blocks instead of TOML's `[table]` markers: find the
 * `  oracle:` line under `mcp_servers:`, then consume every following line
 * indented deeper than it (the block's own content) and stop at the first
 * line that isn't — that's either the next sibling server or the end of the
 * `mcp_servers` section entirely.
 */
function mergeHermesConfig(existing: string, generated: string, force: boolean, filePath: string): string {
  const marker = "  oracle:";
  const lineEnding = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  const markerLine = lines.findIndex((line) => line === marker);
  const generatedBlock = generated.trimEnd().replaceAll("\n", lineEnding);
  if (markerLine < 0) {
    if (lines.some((line) => line.trim() === "mcp_servers:")) {
      // Section exists but has no "oracle" server yet: append just the
      // "  oracle: ..." sub-block right after "mcp_servers:", not a second
      // top-level "mcp_servers:" section.
      const sectionLine = lines.findIndex((line) => line.trim() === "mcp_servers:");
      const oracleBlock = generatedBlock.split(lineEnding).slice(1).join(lineEnding); // drop the "mcp_servers:" line
      const before = lines.slice(0, sectionLine + 1).join(lineEnding);
      const after = lines.slice(sectionLine + 1).join(lineEnding);
      return [before, oracleBlock, after].filter(Boolean).join(lineEnding) + lineEnding;
    }
    return `${existing.trimEnd()}${lineEnding}${lineEnding}${generatedBlock}${lineEnding}`;
  }

  let endLine = markerLine + 1;
  while (endLine < lines.length && /^\s\s\s\s/.test(lines[endLine])) endLine += 1;
  const currentBlock = [lines[markerLine], ...lines.slice(markerLine + 1, endLine)]
    .join(lineEnding)
    .trimEnd();
  const wantedOracleBlock = generatedBlock.split(lineEnding).slice(1).join(lineEnding);
  if (!force && currentBlock !== wantedOracleBlock) throw conflict(filePath);

  const before = lines.slice(0, markerLine).join(lineEnding).trimEnd();
  // No trimStart: `lines.slice(endLine)` starts exactly at the next line of
  // real content (a sibling server, or nothing), never at blank space, and a
  // sibling like "  filesystem:" carries meaningful indentation that
  // trimStart() would strip along with it, corrupting its YAML nesting.
  const after = lines.slice(endLine).join(lineEnding);
  return [before, wantedOracleBlock, after].filter(Boolean).join(lineEnding) + lineEnding;
}

const SERVERS_PATH_BY_FILE: Record<string, string[]> = {
  ".mcp.json": ["mcpServers"],
  "settings.json": ["mcpServers"],
  "opencode.json": ["mcp"],
  "openclaw.json": ["mcp", "servers"]
};

export async function writeMcpSetup(file: SetupFile, force = false): Promise<void> {
  await fs.mkdir(path.dirname(file.path), { recursive: true });
  let content = file.content;
  try {
    const existing = await fs.readFile(file.path, "utf8");
    if (existing === file.content) return;
    if (file.format === "json") {
      const serversPath = SERVERS_PATH_BY_FILE[path.basename(file.path)];
      content = mergeJsonConfig(existing, file.content, force, file.path, serversPath);
    } else if (file.format === "yaml") {
      content = mergeHermesConfig(existing, file.content, force, file.path);
    } else {
      content = mergeCodexConfig(existing, file.content, force, file.path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = `${file.path}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, file.path);
}
