<div align="center">

# Oracle

### The shared memory and coordination layer for AI coding agents

Persistent context · Multi-agent messaging · Verified tasks · Browser and API models

[![CI](https://github.com/OraclePersonal/Oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/OraclePersonal/Oracle/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@oraclepersonal/oracle?color=cb6d51)](https://www.npmjs.com/package/@oraclepersonal/oracle)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-25342d)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-5d5268)](LICENSE)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Browser mode](#browser-mode) · [Configuration](#configuration) · [Documentation](#documentation)

</div>

![Hand-drawn illustration of AI agents exchanging memory and tasks through Oracle](docs/assets/oracle-network-hero.png)

Oracle gives coding agents a place to remember, consult, coordinate, and prove
their work. Connect Claude Code, Codex, Gemini CLI, OpenCode, or any MCP client
to the same local runtime and they can share project knowledge without turning
you into the message bus.

It is not a database product and it does not replace your coding agent. Oracle
is the durable layer between sessions, tools, models, and machines.

## Why Oracle?

AI coding sessions are usually isolated. A useful discovery disappears when a
session closes, parallel agents cannot see each other's progress, and a task can
be reported as complete without any durable verification.

Oracle changes that:

| Need | What Oracle provides |
| --- | --- |
| Remember | Project and global memory with lexical, vector, and graph retrieval |
| Consult | A context bundle of code, memory, docs, and web results sent to the right model |
| Act | A resumable coding loop with workspace controls, approvals, and an audit trail |
| Coordinate | Durable messages, presence, threads, acknowledgements, and Remote Swarm |
| Verify | Assigned tasks with checklists and a review gate before “done” |
| Operate | A persistent runtime, scheduler, Control Center, and replayable events |

## Quick start

Oracle requires **Node.js 24 or newer**.

```bash
npm install -g @oraclepersonal/oracle
oracle doctor
```

Ask a question with project files attached:

```bash
oracle ask "Where is authentication enforced?" -f "src/**/*.ts"
```

Start the persistent runtime and open the Control Center:

```bash
oracle daemon start
oracle control
oracle control url
```

### Connect an MCP client

For Claude Code:

```bash
oracle setup-mcp --client claude-code
```

For another MCP client:

```json
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["-p", "@oraclepersonal/oracle", "oracle-mcp"],
      "env": {
        "ORACLE_WORKSPACE_ROOT": "/path/to/project"
      }
    }
  }
}
```

Restart the client. The `oracle_*` tools will then be available in that
workspace.

## How it works

```text
Claude Code ─┐
Codex ───────┤
Gemini CLI ──┼── MCP / CLI ── Oracle Runtime ── SQLite + project memory
OpenCode ────┤                       │
Other agent ─┘                       ├── model router
                                      ├── task + message bus
                                      ├── scheduler + approvals
                                      └── Control Center
```

Oracle stores local coordination state in `~/.oracle/runtime/oracle.db`.
Project memory lives with the project; optional global memory can carry durable
preferences and conventions across workspaces.

### One question, the right route

`oracle ask` supports explicit provider selection or automatic routing:

```bash
oracle ask "review this change" -f "src/**" --provider anthropic
oracle ask "compare these APIs" --model openai/gpt-5
oracle ask "inspect this package" --model browser:gpt-5.6-sol
oracle ask "check our deployment adapter" --model azure:gpt-5
```

The router understands explicit provider choices, project defaults, model
prefixes, available credentials, Azure preference, and OpenRouter-style
`vendor/model` names. Run `oracle doctor` before a call to see what is ready.

Supported routes include:

- Anthropic, OpenAI, Gemini, Azure OpenAI, and OpenRouter APIs
- Local Codex and OpenCode sessions
- A signed-in ChatGPT browser, locally or through a remote Oracle service

## Browser mode

Browser mode is useful when you want Oracle to consult a signed-in ChatGPT
session instead of sending the request through a model API.

```bash
oracle ask "review this package" -f package.json \
  --provider browser \
  --model gpt-5.6-sol \
  --browser-manual-login
```

The manual-login profile persists. After the first successful login, later
calls reuse it. Long-running answers can automatically reattach if the browser
tab or connection is interrupted.

### Keep the browser on one machine

Run the browser service on the machine that owns the signed-in profile:

```bash
oracle serve
oracle serve --print-command
```

The safe default is `127.0.0.1:9473` with a persistent profile. A client can
then connect through `ORACLE_REMOTE_HOST` and `ORACLE_REMOTE_TOKEN`, or with
`--remote-host` and `--remote-token`.

```bash
oracle ask "review the release" \
  --provider browser \
  --remote-host 192.168.1.20:9473
```

When the service is exposed beyond localhost, use a strong token, an
appropriate firewall rule, and an encrypted private network or HTTPS reverse
proxy. Browser execution is powered by the pinned
[`@steipete/oracle`](https://github.com/steipete/oracle) runtime.

## Multi-agent coordination

Register agents, send durable messages, and wait for work without polling in a
tight loop:

```bash
oracle msg send -f lead -t worker -b "Review the auth changes"
oracle msg inbox -a worker --wait --timeout 120
oracle msg ack -a worker <message-id>
```

Turn a request into verifiable work:

```bash
oracle task create \
  --title "Add rate limiting" \
  --created-by lead \
  --assignee builder \
  --checklist "implement limiter" "add tests" "update docs"

oracle task update <task-id> -a builder --status in_progress
oracle task check <task-id> 0
oracle task submit <task-id> -a builder --summary "Implemented and tested"
oracle task close <task-id> -a lead
```

Submission is blocked until every declared checklist item is checked. Task
events and notifications are persisted so an interrupted workflow can be
recovered without duplicate delivery.

### Across machines

On the Runtime host:

```bash
oracle daemon start --remote --host 0.0.0.0
oracle team token --project my-project --agent lead --role lead
oracle team token --project my-project --agent worker --role worker
```

On each client:

```bash
oracle connect https://oracle.example.com \
  --project my-project \
  --agent worker \
  --token "$ORACLE_SWARM_TOKEN"

oracle team status
oracle team inbox
oracle team task list --active
```

Remote Swarm exposes coordination data only. It does not expose remote shell or
file mutation endpoints.

## Autonomous agent

`oracle agent` runs a resumable tool-use loop in the current workspace:

```bash
oracle agent "add validation and tests" --plan --review
oracle agent "investigate the timeout" --read-only --json
oracle agent "continue the migration" --resume <checkpoint-id>
```

It can read and edit files, run commands, pause for approvals, checkpoint its
state, and record a tamper-evident audit trail. Use an OS or container sandbox
when host-level isolation is required.

## Configuration

Create `.oracle/config.json` to keep routing and browser behavior with the
project:

```json
{
  "provider": "auto",
  "model": "gpt-5.4",
  "routing": {
    "defaultProvider": "codex",
    "preferAzure": false
  },
  "browser": {
    "model": "gpt-5.6-sol",
    "manualLogin": true,
    "autoReattachDelay": "30s",
    "autoReattachInterval": "2m",
    "autoReattachTimeout": "2m"
  },
  "serve": {
    "host": "127.0.0.1",
    "port": 9473,
    "manualLogin": true
  }
}
```

Common credentials:

| Route | Environment |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Remote browser | `ORACLE_REMOTE_HOST`, `ORACLE_REMOTE_TOKEN` |

See the [configuration schema](docs/config-schema.md) and
[CLI reference](docs/cli-reference.md) for the complete surface.

## Command map

| Area | Commands |
| --- | --- |
| Consult | `oracle ask`, `oracle session`, `oracle status`, `oracle doctor` |
| Act | `oracle agent`, `oracle agent-checkpoints`, `oracle audit` |
| Remember | `oracle memory`, `oracle wiki`, `oracle docs` |
| Coordinate | `oracle msg`, `oracle task`, `oracle team`, `oracle swarm` |
| Operate | `oracle daemon`, `oracle control`, `oracle approval`, `oracle schedule` |
| Configure | `oracle init`, `oracle identity`, `oracle models`, `oracle usage`, `oracle setup-mcp` |
| Browser | `oracle serve`, `oracle login`, `oracle logout` |

## Security principles

- Workspace mutation is policy checked and fully audited.
- Risky actions can require human approval or quorum.
- Local runtime credentials and coordination data are owner-scoped.
- Remote tokens are project- and agent-scoped; only their SHA-256 hashes are stored.
- Remote APIs carry coordination state, never an unrestricted remote shell.
- Oracle does not terminate TLS; add HTTPS or a private encrypted network when
  crossing machines.

## Documentation

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Configuration schema](docs/config-schema.md)
- [CLI reference](docs/cli-reference.md)
- [Browser feature parity](docs/feature-parity.md)
- [Runtime](docs/runtime.md)
- [Control Center](docs/control-center.md)
- [Messaging and tasks](docs/MESSAGING.md)
- [Remote Swarm](docs/remote-swarm.md)
- [Scheduler](docs/scheduler.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

```bash
git clone https://github.com/OraclePersonal/Oracle.git
cd Oracle
npm install
npm run build
npm test
```

Before opening a pull request:

```bash
npm run typecheck
npm run test
npm run test:cli
npm run test:runtime
```

## License

[MIT](LICENSE). Oracle is not affiliated with Oracle Corporation or the Oracle
database.

The name refers to something you consult: a shared source of truth that your
agents can remember, return to, and use to reach one another.
