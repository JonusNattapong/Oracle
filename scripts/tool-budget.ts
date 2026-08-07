import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { DEFAULT_PROJECT_CONFIG } from "../src/config/project.js";
import { ConsultService } from "../src/core/consult.js";
import { FileSessionStore } from "../src/session/store.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { OracleRegistry } from "../src/oracles/registry.js";
import { MemoryAdapter } from "../src/memory/adapter.js";
import { ProfileStore } from "../src/identity/profile.js";
import { registerOracleTools } from "../src/mcp/server.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-tool-budget-"));
const provider = {
  id: "codex",
  capabilities: {
    consult: true,
    toolUse: false,
    images: false,
    continuation: false,
    structuredUsage: false,
    supportedPlatforms: [process.platform]
  },
  healthCheck: async () => [],
  run: async () => ({ text: "", usage: {} })
} as any;

try {
  const server = new McpServer({ name: "oracle-tool-budget", version: "1.0.0" });
  registerOracleTools({
    server,
    service: new ConsultService(provider, new FileSessionStore(path.join(root, ".sessions"))),
    config: { ...DEFAULT_PROJECT_CONFIG, include: ["src/**/*.ts"], exclude: [] },
    workspaceRoot: root,
    providerId: "codex",
    skills: new SkillRegistry(root, path.join(root, ".oracle", "skills")),
    oracles: new OracleRegistry(root, root),
    memory: new MemoryAdapter(root),
    globalMemory: new MemoryAdapter(root, "global-memory"),
    profile: new ProfileStore(root),
    providerChecks: async () => []
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "oracle-tool-budget-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools.map((tool) => {
    const schema = JSON.stringify({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} });
    return { name: tool.name, bytes: Buffer.byteLength(schema), estimatedTokens: Math.ceil(schema.length / 4) };
  }).sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  const totalTokens = tools.reduce((sum, tool) => sum + tool.estimatedTokens, 0);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), toolCount: tools.length, totalEstimatedTokens: totalTokens, tools }, null, 2));
  await client.close();
  await server.close();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
