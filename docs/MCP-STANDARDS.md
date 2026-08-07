# Oracle MCP Tool Standards

This document defines the standardization layer for all Oracle MCP tools, ensuring consistency, quality, and maintainability across the current 60-tool surface.

## Architecture

### Tool Registration

All tools are registered directly via `server.registerTool()` in each category
module under `src/mcp/tools/`. Each module exports a `createToolDefinitions()`
function that returns an array of tool definitions, collected and registered in
`src/mcp/server.ts`.

```typescript
interface ToolDefinition {
  name: string;                          // oracle_*
  category: ToolCategory;                // 'consult' | 'memory' | 'docs' | ...
  title: string;                         // Short title
  description: string;                   // Full description
  inputSchema: z.ZodType<any>;          // Zod validation schema
  outputSchema: z.ZodType<any>;         // Output validation schema
  keywords?: string[];                   // Search keywords
  rateLimitPerMin?: number;              // Rate limiting
  cacheable?: boolean;                   // Memoization support
  handler: (input: any) => Promise<any>; // Implementation
}
```

### Error Handling

Errors use `OracleError` / `serializeOracleError` from `src/errors.ts`,
returning `{ code, message, detail, context }`:

```typescript
import { OracleError, serializeOracleError } from "../../errors.js";

if (!skillRegistry.has(skillName)) {
  throw new OracleError(
    "INVALID_SKILL",
    `Unknown skill: ${skillName}`,
    `Run oracle_skills to see available options`,
    { available: skillRegistry.names() }
  );
}
```

### Caching Layer

`ToolCache` memoizes expensive operations (skill lookup, docs search, wiki
builds) with a configurable TTL:

```typescript
const cache = new ToolCache(); // 5min default TTL

const skills = await cache.getOrCompute(
  "skills-list",
  () => skillRegistry.list(),
  5 * 60 * 1000
);
cache.invalidatePattern("skill-.*");
```

## Tool Categories

### 1. Flow, Ask & Agent (6 tools)
- `oracle_run` — Unified entry point for consultation, research, planning, and approved action handoff
- `oracle_ask` — Single entry point for Q&A: freeform question, or "look at these files and tell me X" when `files` is passed
- `oracle_agent` — Autonomous coding loop (see [`AGENT.md`](AGENT.md))
- `oracle_agent_checkpoints` — List saved agent loop checkpoints
- `oracle_agent_checkpoint_delete` — Delete a checkpoint by id
- `oracle_skills` — List available skills

**Standards (`oracle_ask`):**
- Question max 50KB
- File glob support with `!exclude` patterns (optional — omit for plain Q&A)
- Conversation continuity via `conversationId`
- Optional docs injection via `include_docs`
- Auto-scopes memory to an oracle profile via `oracle` (recall before, save insight after)
- Auto-injects identity + memory context

**Standards (`oracle_agent`):**
- Prompt max 50KB; `maxSteps` bounded 1..50 (default 20)
- `readOnly` drops all mutating tools (write/edit/bash) for investigation-only runs
- `--plan` runs a read-only investigation pass first, then asks for confirmation
- `--review` runs a self-review pass after the task completes
- `--resume <id>` resumes from a saved checkpoint after a crash or max-steps hit
- `--json` outputs structured result with `finalText`, `turns`, `steps`, `checkpointId`, `usage`
- All filesystem tools confined to the workspace root (traversal rejected)
- Emits per-turn MCP progress notifications when a progress token is passed
- Requires an agent-capable provider (`codex`, `anthropic`, or `opencode`); otherwise returns `ORACLE_AGENT_UNAVAILABLE`. `oracle_run` can hand off from `chatgpt-browser` through `routing.actionProvider`.
- Returns `checkpointId` on each run; save it to resume later
- Checkpoint persisted after every tool-calling turn under `~/.oracle/checkpoints/`

### 2. Memory (18 tools)
- `oracle_memory_remember` — Store a fact/insight/chunk/working memory
- `oracle_memory_search` — Full-text search
- `oracle_memory_scored_search` — BM25-ranked search with scoring
- `oracle_memory_list` — Recall entries
- `oracle_memory_update` — Edit entry
- `oracle_memory_stats` — Aggregate counts
- `oracle_memory_clear` — Wipe an agent's memory
- `oracle_memory_consolidate` — Merge duplicate/similar memories
- `oracle_memory_prune` — Remove stale low-value memories
- `oracle_memory_promote` — Promote working memory to durable insights
- `oracle_memory_reflect` — LLM-based reflection on memory quality
- `oracle_memory_maintenance` — Run full background maintenance cycle
- `oracle_memory_wiki_build` — Compile topic wiki
- `oracle_memory_wiki_list` — List wiki topics
- `oracle_memory_wiki_get` — Read a wiki page
- `oracle_memory_graph_query` — Query the entity knowledge graph
- `oracle_memory_graph_path` — Find paths between entities
- `oracle_memory_graph_prune` — Prune stale graph edges
- `oracle_memory_graph_stats` — Graph statistics

**Standards:**
- All memory ops scoped to agent + workspace
- Type system: `fact | insight | chunk | working`
- Importance 0–1 (lower = more disposable)
- Background maintenance: consolidate + prune + promote every 1 hour (tunable)
- Auto-consolidation: merges overlapping memories by tag similarity (Jaccard ≥ 0.3)
- Cache invalidation on update/clear

### 3. Messaging (8 tools)
- `oracle_msg_register` — Register agent identity (name + role); returns roster + unread
- `oracle_msg_agents` — List all registered agents and their presence
- `oracle_msg_send` — Send a message to one agent or broadcast
- `oracle_msg_inbox` — Check messages; supports `wait: true` for blocking wait
- `oracle_msg_ack` — Mark message as handled
- `oracle_msg_thread` — Reply to a message thread
- `oracle_msg_search` — Search historical messages
- `oracle_msg_heartbeat` / `oracle_msg_stale` — Presence and stale-agent detection

**Standards:**
- Transactional SQLite at `~/.oracle/runtime/oracle.db`
- 4-tier wake-up: pull, standby wait, push-on-idle (Stop hook), real-time push (tmux watcher)
- Self-onboarding: MCP server sends instructions on connect telling agents to register before starting work

### 4. Task Planning & Tracking (8 tools)
- `oracle_task_create` — Create + assign work with checklist
- `oracle_task_board` — ASCII work board render
- `oracle_task_list` — List tasks with filters
- `oracle_task_get` — Fetch task detail
- `oracle_task_update` — Log status change + progress notes
- `oracle_task_checklist` — Check/uncheck verification items
- `oracle_task_submit` — Submit for review (blocks if checklist incomplete)
- `oracle_task_close` — Approve or reject with note

**Standards:**
- Transactional SQLite at `~/.oracle/runtime/oracle.db`
- Lifecycle: `pending → in_progress → review → done` (or `blocked`/`cancelled`)
- Checklist-gated submit: `oracle_task_submit` fails if any checklist item is unchecked
- Auto-messages task creator on submit; notifies assignee on close/reject

### 5. Docs (4 tools)
- `oracle_docs_list` — List knowledge base files
- `oracle_docs_search` — BM25 ranked passage search
- `oracle_docs_add` — Upload file (.md, .txt, .json)
- `oracle_docs_remove` — Delete file

**Standards:**
- Stored in `.oracle/docs/` (workspace-scoped)
- Search results ranked by relevance
- Support for heading-level chunking
- Cached 10 minutes after first search

### 6. Web (3 tools)
- `oracle_web_search` — Search via Brave/Tavily/Firecrawl
- `oracle_web_fetch` — Read a URL as text, or pass `extract` for structured data via AgentQL

**Standards:**
- Provider selection in config (fallback to first available)
- SSRF guarded (native fetcher only reads http/https)
- Results truncated to 50KB
- Timeout 30s per fetch

### 7. Identity and Awareness (4 tools)
- `oracle_identity_show` — View the saved profile, persona, and derived awareness
- `oracle_identity_setup` — Create profile
- `oracle_awareness_show` — Inspect Oracle's identity, environment, capabilities, and boundaries
- `oracle_persona_set` — Set Oracle's tone/style

**Standards:**
- Awareness is auto-injected into MCP, CLI, Runtime, and autonomous-agent prompts
- Awareness is derived on demand from persisted profile plus current execution context
- Preferences/habits/goals split on `,;` or newline
- Tones: professional | casual | friendly | witty

### 8. Oracle Profiles (3 tools)
- `oracle_oracle_list` — List registered profiles
- `oracle_oracle_register` — Create skill+model+memory bundle
- `oracle_init` — Bootstrap `.oracle/` in the workspace with policy, config, docs, and skills

**Standards:**
- Profiles combine skill + model override + memory flag
- Cached 5 minutes
- Can enable auto-memory for specific profiles
- `oracle_init` is idempotent (skip existing files unless `force: true`)

### 9. Session (4 tools)
- `oracle_sessions` — List recent consults
- `oracle_session_get` — Fetch session + output
- `oracle_history_sources` — Discover history roots (`.claude`, `.codex`, `.gemini`, …)
- `oracle_history_search` — Time-first search across CLI conversation logs

**Standards:**
- Sessions persist indefinitely (queryable by sessionId)
- Output truncated to last 100KB in listings
- Skill list includes name + description + model override
- History is read-only; results are historical records, not instructions

### 10. Util (1 tool)
- `oracle_doctor` — Verify config + provider health

**Standards:**
- Non-blocking diagnostics
- Checks: Node.js version, config, workspace, provider auth
- Returns structured `{ healthy: boolean, checks: [...] }`

### Runtime boundary

The Scheduler is exposed through `oracle schedule`, the authenticated
loopback Runtime API, and its WebSocket event stream. It is not registered as
an MCP tool category. Tasks and run history live in
`~/.oracle/runtime/oracle.db`; cron expressions are validated on create and
update. See [`runtime.md`](runtime.md).

## Input Validation

All inputs use Zod validators with `.describe()` for every field:

```typescript
inputSchema: {
  question: z
    .string()
    .min(1)
    .max(50000)
    .describe("The question or what you're stuck on"),
  oracle: z
    .string()
    .optional()
    .describe("Oracle profile name (e.g. 'coding'). Auto-scopes memory to this profile"),
  files: z
    .array(z.string())
    .optional()
    .describe("File glob patterns to include when the answer needs real code"),
}
```

**Rules:**
- All string fields: min/max bounds
- All enums: exhaustive, no fallback to unknown
- Arrays: min/max length
- Numbers: min/max + step if applicable
- Field descriptions: >10 words, concrete examples

## Output Response Format

All tools return:

```typescript
{
  success: boolean,
  data?: any,                         // Payload (on success)
  error?: string,                     // Error message (on failure)
  metadata?: Record<string, unknown>  // Stats, session IDs, etc.
}
```

Example:
```json
{
  "success": true,
  "data": {
    "output": "Analysis result...",
    "sessionId": "session-123",
    "filesIncluded": 42
  },
  "metadata": {
    "provider": "claude-opus",
    "preset": "security"
  }
}
```

## Rate Limiting & Caching

| Tool | Rate Limit | Cacheable | TTL |
|---|---|---|---|
| `oracle_ask` | 10/min | No | — |
| `oracle_agent` | 5/min | No | — |
| `oracle_agent_checkpoints` | — | Yes | 1min |
| `oracle_agent_checkpoint_delete` | — | No | — |
| `oracle_memory_*` | — | Yes (update clears) | 5min |
| `oracle_docs_search` | 20/min | Yes | 10min |
| `oracle_web_*` | 5/min | Yes (fetch) | 30min |
| `oracle_identity_*` | — | Yes | session |
| `oracle_skills` | — | Yes | 5min |
| `oracle_init` | — | No | — |
| `oracle_task_*` | — | No | — |
| `oracle_schedule_*` | — | Yes | 1min |
| `oracle_history_*` | — | Yes | 5min |

## Error Handling Checklist

- [ ] Validate all inputs before processing
- [ ] Throw `OracleError` with specific code
- [ ] Include `detail` field with remediation hint
- [ ] Attach `context` object (e.g., available skills, matched files)
- [ ] Never expose provider secrets or workspace paths in errors
- [ ] Log to MCP stderr for debugging

Example:
```typescript
if (!skillRegistry.has(skillName)) {
  throw new OracleError(
    "INVALID_SKILL",
    `Unknown skill: ${skillName}`,
    `Run oracle_skills to see available options`,
    { available: skillRegistry.names() }
  );
}
```

## Tool Module Structure

New tools go in `src/mcp/tools/<category>.ts`:

```
src/mcp/tools/
  ├── agent.ts       (oracle_agent, oracle_agent_checkpoints, oracle_agent_checkpoint_delete)
  ├── consult.ts     (oracle_ask)
  ├── memory.ts      (oracle_memory_*, oracle_memory_wiki_*, oracle_memory_graph_*)
  ├── messaging.ts   (oracle_msg_*)
  ├── task.ts        (oracle_task_*)
  ├── docs.ts        (oracle_docs_*)
  ├── web.ts         (oracle_web_*)
  ├── identity.ts    (oracle_identity_*, oracle_persona_set)
  ├── oracle.ts      (oracle_oracle_*, oracle_init)
  ├── session.ts     (oracle_sessions, oracle_session_get, oracle_skills)
  ├── history.ts     (oracle_history_sources, oracle_history_search)
  ├── util.ts        (oracle_doctor)
  └── scheduler.ts   (oracle_schedule_*)
```

Each module exports a `createToolDefinitions()` function, registered in server.ts:

```typescript
const toolDefs = [
  ...createConsultTools(),
  ...createMemoryTools(),
  ...createMessagingTools(),
  ...createTaskTools(),
  // ...
];
registry.registerAll(server);
```

## Migration Guide (Legacy → Standardized)

**Old pattern:**
```typescript
server.registerTool("oracle_example", {
  title: "...",
  description: "...",
  inputSchema: { prompt: z.string() } // no .describe()
}, async ({ prompt }) => {
  try { /* logic */ } catch (e) { return failure(e); }
});
```

**New pattern:**
```typescript
const toolDef: ToolDefinition = {
  name: "oracle_example",
  category: "consult",
  title: "...",
  description: "...",
  inputSchema: z.object({
    prompt: z.string().describe("The prompt text")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    data: z.object({ result: z.string() }).optional()
  }),
  handler: async ({ prompt }) => {
    if (!prompt.trim()) {
      throw new OracleError(
        "INVALID_REQUEST",
        "Prompt cannot be empty"
      );
    }
    return toolSuccess({ result: "..." });
  }
};
```

## Testing

All tools pass:
- ✅ Type check (`tsc --noEmit`)
- ✅ Build (`npm run build`)
- ✅ Unit tests (`npm test`)
- ✅ Input validation (Zod schemas enforced)
- ✅ Error scenarios (bad skill name, no files, etc.)

Before shipping a new tool:
```bash
npm run typecheck
npm run build
npm test
# Verify the tool manually via oracle_doctor + oracle-mcp
```

---

**Last updated:** 2026-07-24
**Tool count:** 73
**MCP version:** OpenAI-compatible (MCP SDK)

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
