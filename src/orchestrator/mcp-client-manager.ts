import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AgentTool, AgentContext } from "../agent/types.js";
import type { McpServerConfig } from "../config/project.js";
import { logMcp, logSandbox } from "../observability/log.js";
import { withTimeout, truncateOutput, EXTERNAL_MCP_RESOURCE_LIMITS } from "../agent/resourcelimits.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; [key: string]: unknown };

/**
 * Manage a set of MCP server connections and expose their tools as AgentTools.
 *
 * Usage:
 *   const mgr = new McpClientManager(configs);
 *   const tools = await mgr.connectAll();
 *   // ... pass tools to agent loop ...
 *   await mgr.disconnectAll();
 */
export class McpClientManager {
  private servers: McpServerConfig[];
  private clients: { client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport }[];

  constructor(servers: McpServerConfig[]) {
    this.servers = servers;
    this.clients = [];
  }

  /** Connect to all servers in parallel, discover tools, return AgentTool[] prefixed with server name. */
  async connectAll(): Promise<AgentTool[]> {
    const connections = this.servers.map(async (server) => {
      try {
        return await this.connectServer(server);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logMcp("error", { serverName: server.name, error, event: "connect" });
        return [];
      }
    });
    const results = await Promise.all(connections);
    return results.flat();
  }

  /** Disconnect all clients. */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      this.clients.map(async ({ client, transport }) => {
        try {
          await client.close();
          await transport.close();
        } catch {
          // ignore cleanup errors
        }
      })
    );
    this.clients = [];
  }

  private async connectServer(server: McpServerConfig): Promise<AgentTool[]> {
    const client = new Client(
      { name: "oracle-agent", version: "0.1.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } }
    );
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (server.url) {
      transport = new StreamableHTTPClientTransport(new URL(server.url));
    } else if (server.command) {
      transport = new StdioClientTransport({ command: server.command, args: server.args ?? [] });
    } else {
      throw new Error(`Server "${server.name}" needs either "url" or "command"`);
    }

    logMcp("connect", { serverName: server.name, type: server.url ? "http" : "stdio" });
    await client.connect(transport);
    this.clients.push({ client, transport });

    // List tools from this server
    const response = await client.listTools({});
    const prefix = server.name.replace(/[^a-z0-9_]/gi, "_");
    const toolCount = response.tools?.length ?? 0;
    logMcp("discover", { serverName: server.name, toolCount, trustedForMutation: server.trustedForMutation ?? false });

    return (response.tools ?? []).map((tool) => ({
      name: `mcp_${prefix}_${tool.name}`,
      description: `[${server.name}] ${tool.description ?? tool.name}`,
      mutating: server.trustedForMutation ?? false,
      inputSchema: (tool.inputSchema as AgentTool["inputSchema"]) ?? { type: "object", properties: {} },
      async execute(input: Record<string, unknown>, ctx: AgentContext): Promise<string> {
        // Log if a mutating tool is called in read-only mode
        if (this.mutating && ctx.readOnly) {
          logSandbox("mutation-denied", { serverName: server.name, toolName: tool.name });
        }
        try {
          logMcp("call", { serverName: server.name, toolName: tool.name });
          const callStart = Date.now();
          const result = (await withTimeout(
            client.callTool({
              name: tool.name,
              arguments: input,
            }),
            EXTERNAL_MCP_RESOURCE_LIMITS.timeoutMs
          )) as ToolResult;
          const callMs = Date.now() - callStart;
          const text = result.content.find((c) => c.type === "text");
          let output = text?.text ?? JSON.stringify(result.content);
          const [truncated, wasTruncated] = truncateOutput(output, EXTERNAL_MCP_RESOURCE_LIMITS.maxOutputBytes);
          logMcp("result", {
            serverName: server.name,
            toolName: tool.name,
            durationMs: callMs,
            outputTruncated: wasTruncated,
          });
          return truncated;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logMcp("error", { serverName: server.name, toolName: tool.name, error: msg });
          return JSON.stringify({ ok: false, error: msg });
        }
      },
    }));
  }
}
