#!/usr/bin/env node
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

await import("dotenv/config");
const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
const { createOracleMcpServer } = await import("./mcp/runtime.js");

serveStdio(() => createOracleMcpServer());

