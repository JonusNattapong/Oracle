# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-07-24

### Added
- Remote Swarm project rooms for cross-machine agent coordination
- Project- and agent-scoped tokens with SHA-256 hashes stored in SQLite
- Remote presence, direct/broadcast messaging, per-agent acknowledgements,
  verified task lifecycle, and project-filtered WebSocket events
- Replay-after-reconnect support through persisted Runtime event ids
- `oracle connect` and `oracle team status|agents|send|inbox|ack|watch`
- Remote token revocation through `oracle team token-revoke`
- `oracle team task create|list|get|update|check|submit|close`
- Explicit `oracle daemon start|run --remote` gate for non-loopback bindings
- Non-destructive legacy import for local message, task, presence, and swarm
  workflow JSON

### Changed
- Package version advanced to Remote Swarm 0.5.0
- Local messages, acknowledgements, tasks, and agent presence now use the
  Runtime SQLite database instead of mutable JSON records
- Local message watch uses SQLite WAL changes as wake-up signals and queries
  the database as its source of truth
- Runtime database schema advanced to version 6

### Security
- Remote tokens never grant shell, filesystem, Scheduler, approval, or admin
  Runtime access
- WebSocket clients receive only events for their token's project
- Raw Remote Swarm tokens are returned once and never persisted by the host
- Non-loopback binding remains rejected unless explicitly enabled
- Cross-machine deployments require TLS termination or an encrypted private
  network; Oracle does not expose its HTTP listener as TLS

## [0.4.0] - 2026-07-24

### Added
- Human approval execution gate with pause, persistent checkpoint, payload verification, resume, and execute-once claim
- Authorized reviewers, multi-reviewer quorum, immutable votes, expiry, and optimistic-lock versions
- Canonical SHA-256 action payload hashes and SQLite-backed execution records
- Tamper-evident audit hash chain with cross-process writer locking and `oracle audit verify`
- Ink Control Center TUI with overview, approval, task, memory, audit, agent, and scheduler tabs
- Approval filtering, detail inspection, rejection reasons, and confirmation prompts in the TUI
- Optional Telegram callback decisions with chat/user allowlists, expiring versioned callbacks, and replay protection
- Runtime API and WebSocket events for votes, expiry, and guarded action execution
- SQLite v2-to-v3 migration coverage and end-to-end human-control-plane tests

### Changed
- Package version advanced to Human Control Plane 0.4.0
- `oracle control` uses Ink in interactive terminals; `--plain` keeps the dependency-free ANSI renderer
- Agent checkpoints expose waiting-approval state, approval id, and pending tool
- Control snapshots now include agent presence, scheduler records, and audit-chain integrity
- High-risk Telegram decisions are local-only by default

### Security
- Guarded tools do not run before an authorized quorum approves the exact hashed payload
- SQLite uniqueness prevents more than one execution claim for an approval
- Stale approval decisions return conflicts instead of overwriting newer state
- Telegram callbacks validate chat, user allowlist, reviewer identity, version, and local-only policy

## [0.3.0] - 2026-07-24

### Added
- Blue, responsive Control Center dashboard served locally at `/control`
- Dependency-free interactive terminal UI through `oracle control`
- Persistent SQLite approval inbox with low/medium/high risk classification
- Automatic task-review approvals linked to the existing TaskStore and CoordinationService
- Approval CLI for request, list, show, approve, and reject workflows
- Control Center snapshot API aggregating task, memory, audit, approval, and Runtime state
- Optional Telegram approval notifications through environment configuration
- Control Center unit, API, terminal rendering, and daemon smoke coverage

### Changed
- Package version advanced to Control Center 0.3.0
- Runtime state records its fixed project workspace for safe visualization
- SQLite schema advanced to version 2 with persistent approval records
- Task approval decisions reuse the durable Task-to-Message coordination flow

### Security
- Dashboard data and mutations remain protected by the owner-only Runtime token
- Dashboard token is passed in the URL fragment, moved into session storage, and removed from the address bar
- Telegram is disabled unless both bot token and chat id are explicitly configured
- Telegram is notification-only; decisions remain inside the authenticated local Control Center

## [0.2.0] - 2026-07-24

### Added
- Persistent `oracle-daemon` process with background and foreground lifecycle commands
- SQLite runtime backend using WAL mode for scheduler tasks, run history, metadata, and events
- Scheduler service owned by the daemon, with idempotent import of legacy JSON tasks
- Token-authenticated loopback HTTP API for scheduler and daemon operations
- WebSocket event stream with SQLite-backed cursor replay
- `oracle daemon start|run|status|stop|events`
- `oracle schedule update` with live rescheduling through the daemon API
- Runtime integration and smoke tests covering API, WebSocket, SQLite, and process lifecycle

### Changed
- Package version advanced to Runtime 0.2.0
- Scheduler CLI commands use the daemon API when available and the same SQLite backend when offline
- `oracle schedule watch` is now a compatibility alias for foreground Runtime

### Security
- Runtime rejects non-loopback bind addresses
- Daemon API credentials are owner-only and redacted from status output

## [0.1.0] - 2026-07-24

### Added
- Durable coordination outbox linking every task lifecycle notification to its persisted message
- Persistent swarm-to-task linkage through `primaryTaskId`, `taskIds`, and `messageIds`
- `oracle swarm recover` and `oracle_coordination_recover` for idempotent workflow recovery
- Automatic migration of legacy swarm proposals into the TaskStore consensus source of truth
- Persistent cron task system (`oracle schedule`) with `list`, `add`, `remove`, `run`, `watch`, `--once` commands
- Agent checkpoint store with list/resume/delete support
- Agent plan mode (`--plan`) for read-only investigation before execution
- Agent self-review mode (`--review`) for post-completion correctness checks
- Agent resume from checkpoint (`--resume <id>`) after `--max-steps` or crash
- Agent JSON output mode (`--json`) for structured `finalText`, `steps`, `checkpointId`
- Bash tool with `$SHELL` respect (Git Bash on Windows, user shell on Unix)
- Codex CLI provider integration
- Cross-tool session history recall (`oracle_history_sources`, `oracle_history_search`)
- `oracle_msg_search` — time-first recall over the whole message bus
- tmux real-time push watcher (`scripts/oracle-tmux-launch.sh`, `scripts/oracle-tmux-push-watcher.mjs`)
- `oracle msg watch` with `--exec` for custom nudge commands
- `oracle msg inbox` blocking wait mode (`--wait --timeout`)
- AST graph memory module (`src/memory/astGraph.ts`)
- Memory decay module (`src/memory/decay.ts`)
- Agent policy module (`src/agent/policy.ts`)
- Task consensus module (`src/tasks/consensus.ts`)
- Observability audit trail (`src/observability/audit.ts`)
- Multi-agent swarm execution (`src/orchestrator/swarm.ts`)
- Scheduler docs (`docs/scheduler.md`)
- LICENSE, CONTRIBUTING.md, SECURITY.md, SUPPORT.md at repo root
- CLI reference (`docs/cli-reference.md`) and troubleshooting guide (`docs/troubleshooting.md`)
- Signatures on all docs
- Updated `docs/AGENT.md` with plan/review/resume/JSON flags
- Updated `docs/MCP-STANDARDS.md` to reflect 49 tools, removed GitHub tools section
- Updated `docs/index.md` as a real GitHub Pages landing page

### Changed
- TaskStore is now the canonical consensus store; SwarmStore keeps a recoverable workflow projection
- Coordination messages carry `taskId`, `workflowId`, and `coordinationEventId`
- Package version advanced to Coordination 0.1.0
- `docs/AGENT.md` — rewritten with current CLI flags, checkpoint/resume, self-review, source map
- `docs/MCP-STANDARDS.md` — rewritten with 49 tools, new categories, error handling checklist
- `docs/index.md` — fixed duplicate entries, added CLI Reference and Troubleshooting links
- Moved `MESSAGING.md` out of `package.json` files array (now only in `docs/`)

### Removed
- `oracle_github_*` tools from all documentation
- Duplicate "Superpowers / Plans" entry from docs/index.md
- `docs/` folder restructure — moved root docs into `docs/` for GitHub Pages
- `docs/index.md` reordered documentation table (new user → deeper reference)
- `docs/MESSAGING.md` relative link fixes from root to `docs/`

### Changed
- MCP tools reorganized into category files under `src/mcp/tools/`
- `CheckpointStore` renamed to `FileCheckpointStore` in agent module
- Agent loop supervisor timeout behavior hardened against fast-fallback hangs
- Agent stdout pollution prevented in orchestrator
- `package.json` files array updated to include `docs`
- README and docs links updated to use `docs/` relative paths

### Fixed
- Interrupted task notifications resume without duplicate messages
- Legacy swarm workflows recover missing linked tasks and proposal ownership
- `oracle_msg_inbox` wait mode timeout and re-arm behavior
- Agent `stdout` pollution breaking MCP protocol framing
- Fast-fallback orchestrator supervisor timeouts
- Windows bash tool shell selection (`$SHELL` fallback)
- Built CLI import paths for the swarm and audit commands
- Swarm workflow state now persists across separate CLI invocations
- Task consensus proposals and votes now persist and accumulate
- Agent tool and policy-denial events now populate `.oracle/audit.jsonl`
- Agent policy loading now fails closed and enforces mutation limits
- Message inbox ordering is deterministic for rapid sequential sends

## [0.0.2] - 2026-07-24

### Added
- Agent resume, plan mode, JSON output, self-review, checkpoint list
- Bash tool and codex agent provider
- Cross-tool session-history recall
- `oracle_msg_search` time-first recall
- tmux real-time push for idle sessions
- 4-tier wake-up model documentation and implementation
- `oracle msg watch` CLI command
- `oracle msg inbox` wait mode
- Agent checkpoint system
- Task planning, tracking, and verification layer
- MCP tool category extraction and error recovery
- Docs: worked example (standby workers + tmux push)
- Docs: 4-tier wake-up model
- Docs: agent flags (plan, review, resume, json, checkpoints)
- Docs: Oracle MCP setup guide and Claude Code integration
- Docs: GitHub Pages content rewrite to match current Oracle
- Repo flatten — `Oracle/` subfolder contents moved to repo root

### Changed
- Agent and messaging tooling matured from prototype to production-ready
- Docs restructured to match current CLI surface

## [0.0.1] - 2026-07-15

### Added
- Initial release: MCP server + CLI with memory, consultation, agent, messaging, and task tracking
- Persistent memory with BM25 + vector search + entity graph
- Consultation engine (`oracle ask`) with code/memory/docs/web context
- Autonomous agent sandbox with audit trail
- Inter-agent message bus (`oracle msg`)
- Task planning & verification (`oracle task`)
- Identity and persona system
- GitHub integration tools
- Docs & web tools
- Session history recall tools
- Oracle profiles & skills system
