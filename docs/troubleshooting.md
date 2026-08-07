# Troubleshooting

Common issues and how to resolve them. If your problem isn't listed here, open
a [GitHub Issue](https://github.com/OraclePersonal/Oracle/issues).

---

## Installation

### `npm install` fails with Node.js version error

Oracle requires **Node.js ≥ 24**. Verify:

```bash
node --version
```

Upgrade from https://nodejs.org/ if needed.

### Build fails: `Cannot find module` errors

Run `npm install` before `npm run build`. If you've just pulled, delete
`node_modules/` and reinstall:

```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```

---

## Provider & Authentication

### `oracle doctor` shows no provider

Set an API key or authenticate with the Codex CLI:

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# Codex CLI (default)
codex login
```

Then: `oracle doctor` should show `OK`.

### `oracle_agent` returns `ORACLE_AGENT_UNAVAILABLE`

The agent loop requires an agent-capable backend: `codex`, `anthropic`, or
`opencode`. ChatGPT Browser Mode is consult-only, so switch the provider for
tool-use tasks or use `oracle ask` for read-only consultation.

```bash
oracle agent "task" --provider anthropic
```

---

## MCP Integration

### `oracle_*` tools not appearing in Claude Code

1. Run `oracle setup-mcp --client claude-code`
2. Verify `.mcp.json` was created in your project root
3. **Close Claude Code completely** and reopen
4. Check the tool list for `oracle_*` entries

### MCP server crashes on startup

Run `oracle doctor` to check for config issues. Ensure `ORACLE_WORKSPACE_ROOT`
points to a valid directory.

---

## Memory

### Memory not recalling prior facts

Check the scope: memory is workspace-scoped by default. Facts stored in one
project won't appear in another unless `scope: "global"` was used.

```bash
oracle memory list                    # see what's stored
oracle memory search "query term"     # verify recall works
```

### Memory growing too large

Auto-consolidation runs every hour. Prune manually:

```bash
oracle memory prune --days 30
```

---

## Messaging

### Messages not showing up

1. Verify both agents are registered:

```bash
oracle msg agents
```

2. Check the agent name matches exactly (case-sensitive).
3. Verify messages are in `~/.oracle/messages/`.
4. Check the inbox directly:

```bash
oracle msg inbox -a "agent-name" --json
```

### Stop hook not waking Claude Code

- Ensure the hook script is installed and executable.
- Hooks that take > 1 second may time out — keep them fast.
- If the hook process dies, Claude closes the turn regardless.

---

## Task Tracker

### Task won't submit (blocks on checklist)

`oracle task submit` **refuses** to move a task to `review` if any checklist
item is still unchecked. Check off all items first:

```bash
oracle task check <task-id> 0
oracle task check <task-id> 1
# ...all items checked
oracle task submit <id> -a <agent> --summary "done"
```

### Task stuck in review

The task creator needs to close it:

```bash
oracle task close <task-id> -a lead
# or reject:
oracle task close <task-id> -a lead --reject --note "needs X"
```

---

## Agent Sandbox

### Agent redoes work after resume

File changes made before the crash are already applied. If the agent redoes
them, check that `resumeId` matches the correct checkpoint and that no other
agent modified the same files between the crash and the resume.

### Bash tool not running

- The bash tool is disabled when `--read-only` is set.
- Commands run in the workspace root; verify you're in the right directory.
- On Windows, `$SHELL` is respected — ensure Git Bash or your shell is set.

---

## Scheduler

### Scheduled task not running

1. Check the task exists: `oracle schedule list`
2. Verify the cron expression is valid
3. Check the Runtime daemon:

```bash
oracle daemon status
oracle daemon start
```

Tasks and run history are persisted to `~/.oracle/runtime/oracle.db`. Legacy
JSON tasks under `~/.oracle/scheduler/` are imported idempotently when Runtime
starts. Use `oracle daemon events` to inspect live scheduler activity.

---

## Windows-specific

### `fs.rename()` EPERM errors under concurrent load

On heavy concurrent writes, Windows can return EPERM on rename. Oracle retries
automatically; if it persists, reduce concurrent agent count.

### Bash tool uses wrong shell

Set `$SHELL` in your environment before running Oracle. Git Bash on Windows is
supported — ensure it's in PATH.

---

## Still stuck?

- **Docs:** [docs/getting-started.md](getting-started.md) · [docs/architecture.md](architecture.md)
- **GitHub Issues:** https://github.com/OraclePersonal/Oracle/issues
- **Discussions:** https://github.com/OraclePersonal/Oracle/discussions

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
