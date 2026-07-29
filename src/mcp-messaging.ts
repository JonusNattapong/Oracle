#!/usr/bin/env node
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

await import("dotenv/config");
const [
  os,
  path,
  { McpServer },
  { serveStdio },
  { MessageStore },
  { AgentRegistry },
  { TaskStore },
  { SwarmStore },
  { CoordinationService },
  { registerMessagingTools, MESSAGING_INSTRUCTIONS },
  { registerTaskTools, TASK_INSTRUCTIONS },
  { VERSION }
] = await Promise.all([
  import("node:os"),
  import("node:path"),
  import("@modelcontextprotocol/server"),
  import("@modelcontextprotocol/server/stdio"),
  import("./messaging/store.js"),
  import("./messaging/registry.js"),
  import("./tasks/store.js"),
  import("./orchestrator/swarmStore.js"),
  import("./coordination/service.js"),
  import("./mcp/messagingTools.js"),
  import("./mcp/taskTools.js"),
  import("./version.js")
]);

/**
 * Standalone coordination MCP server: exposes the `oracle_msg_*` messaging
 * tools and `oracle_task_*` planning/tracking tools over the shared
 * ~/.oracle store, with none of Oracle's provider/memory/agent stack. Wire
 * this into any MCP client that just needs agents to talk and coordinate.
 *
 *   npx -p @oraclepersonal/oracle oracle-msg-mcp
 *
 * Store location follows ORACLE_HOME_DIR (default ~/.oracle), so it shares
 * the exact same bus as the full oracle-mcp server and the `oracle msg`/
 * `oracle task` CLI commands.
 */
serveStdio(() => {
  const homeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
  const server = new McpServer(
    { name: "oracle-messaging", version: VERSION },
    { instructions: `${MESSAGING_INSTRUCTIONS} ${TASK_INSTRUCTIONS}` }
  );
  const messages = new MessageStore(homeDir);
  const tasks = new TaskStore(homeDir);
  const registry = new AgentRegistry(homeDir);
  registerMessagingTools(server, messages, registry);
  registerTaskTools(
    server,
    tasks,
    messages,
    registry,
    new CoordinationService(tasks, messages, new SwarmStore(homeDir))
  );
  return server;
});
