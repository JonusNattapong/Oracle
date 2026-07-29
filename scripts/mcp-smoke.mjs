import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const workspaceRoot = process.argv[2] ?? process.cwd();
const question = process.argv[3];
const serverPath = new URL("../dist/mcp.js", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, ORACLE_WORKSPACE_ROOT: workspaceRoot },
  stderr: "pipe"
});
const client = new Client(
  { name: "oracle-smoke-test", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } }
);

await client.connect(transport);
const tools = await client.listTools();
const doctor = await client.callTool({ name: "oracle_doctor", arguments: {} });
const answer = question
  ? await client.callTool({ name: "oracle_ask", arguments: { question } })
  : undefined;
console.log(JSON.stringify({
  protocolVersion: client.getNegotiatedProtocolVersion(),
  protocolEra: client.getProtocolEra(),
  toolCount: tools.tools.length,
  tools: tools.tools.map((tool) => tool.name),
  doctor: doctor.content,
  ...(answer ? { answer: answer.content } : {})
}, null, 2));
await client.close();
