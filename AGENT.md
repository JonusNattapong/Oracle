# Oracle Agent — Autonomous Coding Loop

Oracle can act as an autonomous coding agent: you give it a task, and it
reads, writes, and edits files and searches the codebase in a **tool-use
loop** until the task is complete. It has a **bash** tool for running shell commands — confined to the workspace, with timeout and audit trail
feature (see [Safety boundaries](#safety-boundaries)). This document
explains how it works, the toolset, safety boundaries, and how to use it
from the CLI and MCP.

## How it works

```
task ──► [ provider.runAgentTurn ] ──► assistant text + tool calls
              ▲                               │
              │                               ▼
        tool results  ◄──── [ execute each tool in the workspace ]
              │                               │
              └───────────────  loop  ◄───────┘
                    (until no tool calls, or maxSteps reached)
```

1. The task becomes the first user message.
2. The provider returns assistant text plus zero or more **tool calls**.
3. Each tool call is executed against the workspace; results are fed back.
4. The loop repeats until the model stops calling tools (it's done) or the
   `maxSteps` cap is hit.

The loop itself (`src/agent/loop.ts`) is **provider-agnostic**. Each provider
translates the neutral transcript to/from its own wire format:

- **Anthropic** — native `tool_use` / `tool_result` blocks (`src/providers/anthropicProvider.ts`)
- **opencode** (OpenAI-compatible) — chat-completion function calling (`src/providers/openaiProvider.ts`)
- **codex** — uses the Codex CLI process (non-agentic; no tool-use loop)

`oracle_agent` requires an agent-capable provider (`anthropic` or `opencode`);
otherwise it returns `ORACLE_AGENT_UNAVAILABLE`.

## CLI flags

| Flag | Purpose |
|---|---|
| `--plan` | Read-only investigation pass first; shows the plan and asks for confirmation before executing |
| `--review` | After completion, runs a self-review pass checking for bugs, missing error handling, and edge cases |
| `--resume <id>` | Resume from a saved checkpoint after a crash or max-steps hit |
| `--json` | Structured output: `finalText`, `turns`, `steps`, `checkpointId`, `usage` |
| `--read-only` | Drops all mutating tools (write/edit/bash); investigation only |
| `--sandbox <mode>` | Enforce process/network containment (`docker`, `namespace`, or `none`) |
| `--max-steps <n>` | Cap the loop (default 20, max 50) |
| `--provider <name>` | Override provider for this run |
| `--model <name>` | Override model for this run |

## Toolset

All tools live in `src/agent/loop.ts` and `src/agent/service.ts`. Filesystem
access is confined to the workspace root — a single trust boundary
(`resolveInWorkspace`) rejects any path that escapes it. The agent also has a
**bash** tool for running shell commands (disabled in readOnly mode).

| Tool | Mutating | Purpose |
|---|---|---|
| `read_file` | no | Read a UTF-8 file (truncated if very large) |
| `list_dir` | no | List a directory's immediate entries |
| `glob` | no | Find files whose path contains a substring |
| `grep` | no | Search file contents; returns `path:line: text` |
| `read_image` | no | Read an image file for a vision-capable model |
| `read_video` | no | Read a video file for a vision-capable model |
| `write_file` | yes | Create/overwrite a file (makes parent dirs); audited |
| `edit_file` | yes | Replace an exact, unique string in a file; audited |
| `bash` | yes | Run a shell command in the workspace root (respects `$SHELL`, timeout, audited, disabled in readOnly) |

## Safety boundaries

- **Container & Process Sandbox** — Docker container isolation (`--sandbox=docker`) drops all capabilities (`--cap-drop ALL`), disables networking (`--network=none`), limits CPU/memory/pids (fork-bomb ceiling), and mounts workspace as a read-only root with a writable workspace mount. Linux namespace fallback (`--sandbox=namespace`) uses `unshare(1)` and `ulimit -u`.
- **Shell confined** — the `bash` tool runs in the workspace root with a timeout; it is disabled in readOnly mode. Every command is logged to the audit trail. On Windows, `$SHELL` is respected (e.g. Git Bash); on Unix, the user's shell is used.
- **Workspace confinement** — every path is resolved against the workspace root;
  traversal outside it (`../`) is rejected before any I/O happens.
- **Read-only mode** — pass `readOnly` (MCP) or `--read-only` (CLI) to drop
  both mutating tools (`write_file`, `edit_file`, `bash`) entirely, so the agent can
  investigate without changing anything.
- **Plan mode** — `--plan` runs a read-only investigation pass first, presents the plan, and asks for confirmation before any mutation.
- **Step cap** — `maxSteps` (default 20, max 50) bounds the loop so it can't run forever.
- **Output cap** — each tool truncates its output (30k chars) so a huge file
  can't blow up the context.
- **Audit trail** — every `write_file`/`edit_file`/`bash` call is recorded (path,
  size, SHA-256 content hash, diff summary) so mutations can be reviewed or replayed after
  the run; see `src/agent/audit.ts`.

The agent operates on the user's own workspace intentionally; it does not redact
file contents (the model needs real code to edit). Use `readOnly` when you only
want analysis.

## Checkpoint & Resume

If the agent process crashes mid-run (network blip, OOM, accidental kill), the
work is **not lost**. The agent loop saves a checkpoint after every tool-calling
turn. Resume from the last checkpoint by passing `resumeId` with the
`checkpointId` from a previous (interrupted) run.

```jsonc
{
  "name": "oracle_agent",
  "arguments": {
    "prompt": "continue implementing the feature",
    "resumeId": "cp-20260722-a1b2c3d4"
  }
}
```

The agent reconstructs the full transcript, skips already-completed turns, and
continues from where it left off. Tool implementations are rebuilt from the
current environment — only the transcript is persisted, not runtime state.

**Note on duplicate work:** file changes made before the crash are already
applied. The model sees the full transcript including prior tool calls and
results, so it will not redo completed work unless the task explicitly asks for
it.

Two supporting MCP tools:

| Tool | Purpose |
|---|---|
| `oracle_agent_checkpoints` | List saved checkpoints with timestamps |
| `oracle_agent_checkpoint_delete` | Remove a checkpoint by id |

Checkpoint files live in `~/.oracle/checkpoints/`. They are automatically
deleted on successful completion.

Long runs emit MCP progress notifications (one per turn) when the client passes
a progress token.

## Self-review

When `--review` is passed, after the main task loop finishes, a second
read-only pass runs with the same model. It checks for:
- Correctness bugs introduced during the task
- Missing error handling
- Security issues
- Edge cases not covered

The review result is included in the structured output alongside the main
result.

## CLI usage

```bash
# Implement something (writes files, runs tests)
oracle agent "add a --verbose flag to the CLI and update the README"

# Investigate without touching anything
oracle agent "explain how sessions are persisted" --read-only

# Plan first, then confirm and execute
oracle agent "refactor the auth module" --plan

# Execute with self-review
oracle agent "fix the login bug" --review

# Get structured JSON output
oracle agent "add input validation" --json

# Resume from a checkpoint
oracle agent "finish the task" --resume cp-20260723-...

# List saved checkpoints
oracle agent-checkpoints
```

Progress is printed to stderr per turn (`[turn 3] → read_file, edit_file`); the
final answer goes to stdout.

## MCP usage

The `oracle_agent` tool exposes the same capability to any MCP client:

```jsonc
{
  "name": "oracle_agent",
  "arguments": {
    "prompt": "add input validation to the config loader and a test for it",
    "readOnly": false,         // optional; true = investigate only
    "maxSteps": 20,            // optional; 1..50
    "resumeId": "cp-..."       // optional; resume from a checkpoint
  }
}
```

Structured result:

```jsonc
{
  "finalText": "Added zod validation … and a passing test.",
  "turns": 6,
  "stoppedOnLimit": false,
  "steps": [ { "turn": 1, "text": "...", "toolsUsed": ["read_file"] }, ... ],
  "usage": { "inputTokens": 12000, "outputTokens": 3400 },
  "checkpointId": "cp-20260722-a1b2c3d4"   // save this to resume later
}
```

If the configured provider can't run the agent, `oracle_agent` returns an
`ORACLE_AGENT_UNAVAILABLE` error explaining that you need `anthropic` or
`opencode` (set it in `.oracle/config.json` or via `--provider`).

## Configuration

Set the provider in `.oracle/config.json`:

```json
{
  "provider": "anthropic",
  "model": "auto"
}
```

- `anthropic` — uses `ANTHROPIC_API_KEY` or an OAuth session (`oracle login --provider anthropic`). `model: "auto"` picks the best model for your subscription tier.
- `opencode` — any OpenAI-compatible endpoint via `OPENCODE_API_KEY` / `OPENCODE_API_BASE` / `OPENCODE_MODEL`.
- `codex` — uses the local Codex CLI process; does not support the agentic tool-use loop.

## Source map

| File | Responsibility |
|---|---|
| `src/agent/types.ts` | Neutral types (`AgentMessage`, `ToolCall`, `AgentTool`, `AgentProvider`) |
| `src/agent/loop.ts` | Provider-agnostic tool-use loop + checkpoint save/resume |
| `src/agent/checkpoint.ts` | Disk-backed checkpoint store for crash recovery |
| `src/agent/policy.ts` | Safety policy: workspace confinement, read-only mode, bash allowlist |
| `src/agent/sandbox.ts` | Process and network isolation (Docker container / Linux namespace fallback) |
| `src/agent/audit.ts` | Audit trail: records every file mutation with a content hash |
| `src/agent/service.ts` | `AgentService` — wires tools + provider, runs the loop |
| `src/providers/anthropicProvider.ts` | `runAgentTurn` via native tool use |
| `src/providers/openaiProvider.ts` | `runAgentTurn` via OpenAI function calling (opencode) |
| `src/mcp/tools/agent.ts` | `oracle_agent` + `oracle_agent_checkpoints` + `oracle_agent_checkpoint_delete` MCP tools |
| `src/cli.ts` | `oracle agent` and `oracle agent-checkpoints` commands |

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
