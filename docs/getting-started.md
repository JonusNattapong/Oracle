---
title: Getting Started
---

# Getting Started

## Prerequisites

- Node.js >= 24
- Codex CLI login, or an Anthropic/OpenAI API key

## Install

From npm (recommended):
```bash
npm install -g @oraclepersonal/oracle
```

Or run without installing:
```bash
npx -p @oraclepersonal/oracle oracle doctor
```

From source (for development):
```bash
git clone https://github.com/OraclePersonal/Oracle.git
cd Oracle
npm install
npm run build
```

## Configure an execution backend

```bash
# Codex CLI (default)
codex login

# OR Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OR OpenAI
export OPENAI_API_KEY=sk-...
```

The legacy name `provider` still works, but new configuration and commands use
`backend`.

### Optional: ChatGPT Browser Mode

```bash
oracle browser setup
# Log into ChatGPT in the visible Chrome window.
```

Then enable `experimental.browserMode` and select `chatgpt-browser` in
`.oracle/config.json`. See [browser-mode.md](browser-mode.md) for the complete
configuration and limitations.

## Verify

```bash
oracle doctor
```

## Ask questions

```bash
oracle ask "What does ECONNRESET mean?"

# Code review with files
oracle ask -f "src/**/*.ts" "Review this for edge cases"

# Multi-turn: give Oracle a conversation id and it recalls prior turns
oracle ask "What causes Redis timeouts?" --conversation redis-1
oracle ask "Does that apply to clusters?" --conversation redis-1

# Pull in your project's .oracle/docs/ knowledge base
oracle ask "how does auth work here?" --include-docs

# Pick a personality
oracle ask "review this code" --soul engineer
```

## Initialize the workspace

```bash
oracle init workspace
```

Creates `.oracle/` in the current directory with `policy.json` (zero-trust
rules for the autonomous agent), `config.json` (provider/model/project scope),
`docs/` (knowledge base), and `skills/` (local skill definitions). Use
`--force` to overwrite existing files.

## Run the autonomous agent

```bash
oracle agent "add error handling to src/handler.ts and add a test"
```

The agent reads/writes/edits files and runs shell commands to complete the task. Shell
commands start in the workspace with policy checks, approval gates, a timeout and audit
trail, and are disabled in readOnly mode. Use OS or container isolation when host-level
shell confinement is required.

## Coordinate multiple agent sessions

```bash
oracle msg send -f me -t peer -b "review this when you get a chance"
oracle msg inbox -a me --wait --timeout 120
oracle task create --title "Add rate limiting" --created-by lead --assignee builder \
  --checklist "implement limiter" "add tests"
```

See [MESSAGING.md](MESSAGING.md)
for the full messaging + task-tracking flow, including wake-up hooks for idle
agent sessions.

## Wire up as an MCP server

```bash
oracle setup-mcp --client claude-code
```

Or configure any MCP client manually:
```json
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["-p", "@oraclepersonal/oracle", "oracle-mcp"],
      "env": { "ORACLE_WORKSPACE_ROOT": "/path/to/your/project" }
    }
  }
}
```

If you only need agents to coordinate (no memory/provider/agent stack), wire
the lighter `oracle-msg-mcp` binary instead:
```json
{
  "mcpServers": {
    "oracle-messaging": {
      "command": "npx",
      "args": ["-p", "@oraclepersonal/oracle", "oracle-msg-mcp"]
    }
  }
}
```

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
