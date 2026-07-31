---
title: Oracle
---

# Oracle

**A persistent coordination layer for AI coding agents** — not a database, not a
replacement for your agent, but a shared teammate that remembers everything and
keeps everyone on the same page.

A stateless coding agent forgets everything the moment a session ends. Two
agent sessions running in parallel can't talk to each other. Getting an agent
to actually *act* — not just suggest — usually means babysitting every file
change.

Oracle is an MCP server + CLI that any agent (Claude Code, opencode, Codex,
Gemini CLI, …) wires into to fix that.

## Quick Start

```bash
npm install -g @oraclepersonal/oracle
oracle doctor                          # verify a provider is wired up
oracle setup-mcp --client claude-code  # wire the MCP server into Claude Code
```

Or without installing:
```bash
npx -p @oraclepersonal/oracle oracle ask "review this" -f "src/**/*.ts"
```

## Core Pillars

| Pillar | What it does |
|---|---|
| 🧠 **Remember** | Persistent memory across sessions, auto-ranked by recency, frequency, semantic match, and importance. Entity graph links related knowledge. Auto-consolidation kills duplicates. |
| 💬 **Consult** | Ask a question with real project context — code files, memory, docs, web search/fetch — and get a grounded, cited answer. |
| 🛠️ **Act** | An autonomous agent that reads/writes/edits files and runs policy-checked shell commands from the workspace. Risky actions pause for approval; use OS/container isolation for a host sandbox. |
| 📨 **Coordinate** | A transactional SQLite bus for local agents plus authenticated Remote Swarm rooms for agents on different machines. |
| ✅ **Verify** | A task tracker on top of the bus: assign work with a checklist, log progress, and submit for review — which **blocks** until every checklist item is actually checked off. The task creator is notified automatically. |
| ⏰ **Runtime** | Persistent daemon for SQLite coordination, scheduling, authenticated APIs, and replayable WebSocket events. |
| 🖥️ **Control** | Blue dashboard and Ink TUI for quorum approvals, guarded execution, workflow recovery, memory, and audit integrity. |

## Documentation

| # | Doc | Description |
|---|-----|-------------|
| 1 | [Getting Started](getting-started.md) | Install, configure, and verify your setup |
| 2 | [Quick Start](ORACLE_QUICKSTART.md) | Step-by-step MCP setup and first tools |
| 3 | [CLI Reference](cli-reference.md) | Every `oracle` subcommand and flag |
| 4 | [Architecture](architecture.md) | System components, storage layout, provider routing |
| 5 | [Agent & Sandbox](AGENT.md) | The autonomous agent, its constraints, and the audit trail |
| 6 | [MCP Standards](MCP-STANDARDS.md) | Conventions for the MCP tool surface |
| 7 | [Claude Code Usage](CLAUDE_CODE_USAGE.md) | Using Oracle MCP tools within Claude Code |
| 8 | [Setup Checklist](SETUP_CHECKLIST.md) | Verification checklist for MCP setup |
| 9 | [Setup Complete](SETUP_COMPLETE.md) | What was configured and how to test it |
| 10 | [Messaging & Task Tracking](MESSAGING.md) | Inter-agent messaging, wake-up tiers, task workflow |
| 11 | [Scheduler](scheduler.md) | Runtime-backed cron task commands and expressions |
| 12 | [Runtime](runtime.md) | Daemon, SQLite, local API, WebSocket events, security |
| 13 | [Remote Swarm](remote-swarm.md) | Cross-machine agents, scoped tokens, messages, tasks, replay |
| 14 | [Control Center](control-center.md) | Dashboard, TUI, approval inbox, Telegram notifications |
| 15 | [Troubleshooting](troubleshooting.md) | Common issues and how to resolve them |
| 16 | [Superpowers / Specs](superpowers/specs/) | Architecture design specs |
| 17 | [Changelog](/CHANGELOG.md) | Release notes and version history |
| 18 | [Init](getting-started.md#initialize-the-workspace) | Bootstrap `.oracle/` for a new project |
| 19 | [Roadmap v0.6.0](roadmap-0.6.0.md) | Memory Engine foundation and agent coordination |
| 20 | [Roadmap v0.7.0](roadmap-0.7.0.md) | Cost tracking, provider expansion, sandbox hardening, graph visualization |
| 21 | [ACTB Governance Framework](superpowers/specs/2026-07-30-actb-governance-framework.md) | Awareness, Control, Transform, Boundary agent alignment architecture |
| 22 | [Situated Companion](companion.md) | Semantic presence, self-initiated intents, silence gates, and privacy controls |
| 23 | [Bridge](bridge.md) | Share one signed-in browser across machines over an SSH tunnel |
| 24 | [Advisory panels](panel.md) | Ask several backends one question; partial-success manifests |

## MCP Tools

Memory · Docs & web · Task tracking · Messaging · Consultation & agent ·
Identity & config · Oracle profiles & skills · Session & history · Util.

Full tool-by-tool breakdown and the messaging/task-tracking onboarding flow
live in [MESSAGING.md](MESSAGING.md).

## Storage Layout

```
~/.oracle/
├── runtime/     # SQLite coordination/scheduler/approval state, daemon state, logs
├── remote.json  # owner-only Remote Swarm connection profile
├── messages/    # retained legacy import source
├── tasks/       # retained legacy import source
├── scheduler/   # legacy cron JSON imported into Runtime
├── agents/      # retained legacy import source
├── memory/      # persistent memory: facts, insights, wiki, entity graph
├── skills/      # local skill definitions
└── souls/       # personality prompts (default/engineer/custom)
```

## Why "Oracle"?

An oracle is something you *consult* — it remembers, it knows, and it
answers. This project is that for your agents: a shared source of truth
they return to across sessions, and a switchboard they use to reach each
other. It's provider-neutral (any model backend) and agent-neutral (any MCP
client) — it sits *beside* your coding agent, not instead of it.

## License

MIT. Not affiliated with Oracle Corp or the Oracle database.
