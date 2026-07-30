---
title: Architecture
---

# Architecture

```
you ──▶ oracle ask ──▶ context (memory · docs · web · files) ──▶ model ──▶ answer
              │                                                              │
     conversation continuity                                       remembers what it said
              │                                                              │
     memory (facts · insights · wiki · entity graph)  ◀──▶  bus (messages · tasks · presence)
```

Oracle combines an MCP server and CLI with an optional persistent Runtime
daemon. Coordination and memory remain local stores under `~/.oracle/`;
Runtime owns long-lived scheduling, SQLite state, and authenticated
HTTP/WebSocket APIs. Remote Swarm adds project-scoped coordination across
machines. Control Center is the human-facing projection over those
stores and does not replace their existing sources of truth.

## Components

| Component | Responsibility | Source |
|---|---|---|
| **CLI** | Commander-based CLI: `ask`, `agent`, `memory`, `wiki`, `docs`, `web`, `msg`, `task`, `identity`, `github`, `session`, `skill` | `src/cli.ts` |
| **MCP Server** | Stdio MCP server exposing Oracle's full tool surface | `src/mcp/server.ts`, `src/mcp/runtime.ts` |
| **Standalone coordination server** | `oracle-msg-mcp` binary — 21 messaging, task, consensus, and recovery tools without the provider/memory/agent stack | `src/mcp-messaging.ts` |
| **Runtime daemon** | Long-lived Scheduler owner, SQLite backend, local/admin API, project-scoped Remote Swarm API, WebSocket events | `src/runtime/`, `src/daemon.ts` |
| **Remote Swarm** | Cross-machine messages, presence, verified tasks, scoped tokens, reconnect replay | `src/runtime/swarmService.ts`, `src/runtime/swarmClient.ts` |
| **Control Center** | Web dashboard, Ink TUI, quorum/expiry approvals, execute-once gate, optional Telegram callbacks | `src/control/` |
| **ConsultService** | Core loop: build a validated file bundle → select execution backend → record answer | `src/core/consult.ts`, `src/context/bundleService.ts` |
| **Execution backends** | Codex CLI, Anthropic, OpenAI, Gemini, OpenCode, and experimental ChatGPT Browser Mode | `src/backends/`, `src/providers/` |
| **Execution sandbox** | Shared policy-only or fail-closed Docker runner for agent and scheduler commands, with per-run SQLite evidence. | `src/sandbox/`, `src/agent/`, `src/runtime/schedulerService.ts` |
| **Memory system** | BM25 + vector search + entity knowledge graph + auto-consolidation + background maintenance | `src/memory/` |
| **Messaging bus** | Transactional SQLite message store, presence registry, real-time watcher, Stop-hook wake-up | `src/messaging/` |
| **Task tracker** | Plan/assign/verify/report on top of the messaging bus; checklist-gated review | `src/tasks/` |
| **Coordination service** | Durable Task↔Message outbox, Swarm linkage, consensus reconciliation, recovery | `src/coordination/` |
| **Scheduler service** | Cron lifecycle over a repository port; SQLite in Runtime, legacy file store for compatibility | `src/scheduler/`, `src/runtime/schedulerService.ts` |
| **Docs knowledge base** | BM25-indexed local doc retrieval | `src/docs/` |
| **Web providers** | Brave, Tavily, Firecrawl, AgentQL with auto-fallback | `src/web/` |
| **Skills** | Built-in + custom skill loading | `src/skills/` |
| **Wiki** | Compile memory into topic-grouped pages | `src/wiki/` |
| **Soul prompts** | Personality system, loaded from `~/.oracle/souls/` | `src/core/souls.ts` |
| **Identity** | Profile store and persona management | `src/identity/` |
| **GitHub integration** | PR/issue listing, diffs, reviews, comments via `gh` CLI | `src/github/` |

## Inter-agent coordination

Every `oracle-mcp` process and every `oracle msg`/`oracle task` CLI call on
one machine shares the same WAL-mode SQLite database at
`~/.oracle/runtime/oracle.db`. Local coordination does not require the
daemon; each process opens the same transactional store.

Remote agents connect to the daemon with a project- and agent-scoped token.
The Remote Swarm API exposes messages, tasks, presence, and filtered
WebSocket events only. See [remote-swarm.md](remote-swarm.md).

Coordination 0.1.0 connects those stores through a durable outbox. A task
transition first persists a pending coordination event, then delivers a
message carrying `taskId`, `workflowId`, and `coordinationEventId`. Delivery
uses a deterministic message id, so `oracle swarm recover` or
`oracle_coordination_recover` can replay an interrupted transition without
duplicating the message. Swarm workflows persist their primary task,
consensus projection, linked messages, and recovery metadata.

**Wake-up has four tiers**, weakest to strongest:

1. **Pull** — an agent calls `oracle_msg_inbox` whenever it wants.
2. **Standby wait** — `oracle_msg_inbox { wait: true }` blocks (up to
   `timeoutSeconds`, max 600) until an unread message lands, then returns it;
   on timeout the agent re-arms. No config — for plain windows told to
   stand by for work.
3. **Push-on-idle** — a Claude Code Stop hook (`scripts/oracle-msg-stop-hook.mjs`)
   blocks the agent from ending its turn while unread messages remain.
4. **Real-time push** — an external watcher types into the agent's tmux pane
   the instant a message lands, waking a fully idle session:
   `scripts/oracle-tmux-launch.sh <agent>` (Claude + watcher in one command)
   or `oracle msg watch --exec "<cmd>"` for a custom nudge.

**Self-onboarding:** the MCP server sends `instructions` to every client on
connect, teaching it to call `oracle_msg_register` and check its task list
before starting work — no human has to explain the flow.

## Task verification gate

`oracle_task_submit` (and its CLI equivalent) refuses to move a task to
`review` if any checklist item created with the task is still unchecked. This
turns "I'm done" from a claim into something that's actually been verified
## Governance & Alignment (ACTB Framework)

Oracle employs the **ACTB Governance Framework** (Awareness, Control, Transform, Boundary) to ensure safe, transparent, and aligned AI agent operations:

- **Awareness**: Audit trails for all mutations (`sandbox_runs`), token cost accounting (`CostTracker`), presence heartbeats, and live event monitoring.
- **Control**: Human approval inbox (`oracle control`), execution step ceilings (`maxSteps`), budget limits, and risk policies (`off`, `risky`, `all-mutations`).
- **Transform**: Memory auto-consolidation (Jaccard tag similarity deduplication & decay), topic Wiki compilation, soul persona routing, and response stabilization.
- **Boundary**: Strict workspace path containment (`resolveInWorkspace`), isolated Chrome automation profile, Remote Swarm token scoping, and checklist verification gates (`oracle_task_submit`).

See [2026-07-30-actb-governance-framework.md](superpowers/specs/2026-07-30-actb-governance-framework.md) for the full architecture specification.

## Execution backend routing

| Backend | Auth |
|---|---|
| codex (default) | Codex CLI login |
| anthropic | `ANTHROPIC_API_KEY` |
| openai | `OPENAI_API_KEY` |
| opencode | `OPENCODE_API_KEY` |
| gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| chatgpt-browser (experimental) | Manual login in Oracle's isolated Chrome profile |

The legacy `provider` config key remains accepted and is normalized to
`backend`. Browser Mode is consult-only and must also be enabled with
`experimental.browserMode`.

## Storage layout

```
~/.oracle/
├── runtime/
│   ├── oracle.db        # coordination, Remote Swarm, scheduler, events, approvals
│   ├── daemon.json      # pid, endpoint, owner-only admin token
│   └── daemon.log       # detached process output
├── remote.json          # saved agent-scoped Remote Swarm profile
├── messages/            # retained legacy import source
├── tasks/               # retained legacy import source
├── agents/              # retained legacy import source
├── swarms/              # retained legacy workflow import source
├── scheduler/           # legacy JSON tasks imported into SQLite
├── memory/               # facts · insights · wiki · entity graph
├── skills/                # custom skill definitions
├── souls/                 # personality prompts (default/engineer/custom)
├── oracles/               # named oracle profiles (skill+model+provider+memory bundles)
└── sessions/<id>/         # consult history

<project>/
└── .oracle/
    ├── config.json         # per-project include/exclude, provider, model
    ├── audit.jsonl         # tamper-evident agent and approval hash chain
    ├── docs/                # knowledge base source files
    └── skills/              # project-local skill overrides
```

## Security model

The agent and Runtime scheduler share a command runner that starts in the active
workspace, applies command policy and human approval gates, and records
timeout-backed evidence. Its default `none` mode is policy-constrained only.
Optional Docker mode binds only the workspace, uses a read-only root filesystem,
disables networking by default, drops Linux capabilities, and fails closed if
Docker cannot start. See [Execution sandbox](sandbox.md).
Every mutation is logged with a timestamp,
agent name, SHA-256 content hash, and diff summary, so file changes and commands can be
audited or reverted after the fact. The bash tool is disabled in readOnly mode.

Local coordination lives in an owner-only SQLite database. Remote Swarm
stores only token hashes and filters every request and event by project.
Remote tokens do not grant shell, filesystem, Scheduler, approval, or admin
access. Cross-machine deployments require TLS termination or an encrypted
private network because the built-in listener is HTTP.

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
