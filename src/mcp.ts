#!/usr/bin/env node
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

await import("dotenv/config");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createOracleMcpServer } = await import("./mcp/runtime.js");

const server = await createOracleMcpServer();
await server.connect(new StdioServerTransport());

