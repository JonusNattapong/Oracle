# Oracle


> **Oracle is a persistent coordination layer for AI coding agents — not a database, not a replacement for your agent, but a shared teammate that remembers everything and keeps everyone on the same page.**

When you fire up Claude Code, it has no memory of yesterday's work. If you start two Claude sessions, they can't talk to each other. If you want the agent to actually *do* something (not just talk about doing it), you have to manually approve every file change and run every command.

**Oracle fixes this.** It is an MCP server that any agent wires into (Claude Code, opencode, Codex, Gemini CLI, …) to gain:

- **Persistent memory** — everything the agent learns is saved and ranked by relevance; future sessions find it instantly
- **Consultation engine** — ask a question with full project context (code + memory + docs + web) and get a grounded answer with citations
- **Autonomous action** — an agent sandbox that can read/write files and run commands, confined to your workspace, fully audited
- **Inter-agent coordination** — agent sessions on one or many machines can message each other, hand off work, and wake each other through a project-scoped Remote Swarm
- **Task planning & verification** — a lead breaks work into assigned tasks with checklists; agents can't report "done" until their declared verification steps are actually checked off, and the lead is auto-notified when work is ready to review
- **ASCII work board** — a lead can render the live agent roster and its main TODOs in any MCP client with `oracle_task_board`
- **Control Center** — a blue local dashboard and Ink TUI for authorized approvals, task flow, memory, and the tamper-evident audit chain

**Requires Node.js ≥ 24.** Installs three binaries: `oracle` (CLI), `oracle-mcp` (full MCP server), `oracle-msg-mcp` (messaging + task-tracking server for agents that only need to coordinate, not consult or act).

---

## What Problem Does Oracle Solve?

### Without Oracle

```
Session 1: Claude Code
  └─ Learns that Service X uses connection pool Y
  └─ Closes session
     └─ All context is gone forever

Session 2: Different Claude Code session
  └─ Asks the same question again
  └─ No way to know what Session 1 learned

Session A: Claude Code session (refactoring)
Session B: Claude Code session (bug fix)
  └─ They're isolated; A has to DM you to tell B what changed
  └─ You act as the messenger
```

### With Oracle

```
Session 1: Claude Code → Oracle
  └─ Learns fact X → stored in memory
  └─ Closes session
     └─ Fact X stays in the shared store

Session 2: Claude Code → Oracle
  └─ Asks a question
  └─ Oracle recalls Fact X automatically (ranked by relevance)
  └─ Answer is grounded in what Session 1 learned

Session A: Claude Code → Oracle
  └─ Sends: "Refactoring done, 3 files changed"

Session B: Claude Code → Oracle
  └─ Receives message from A instantly
  └─ Can ask Oracle to fetch the list of changed files
  └─ Coordinates autonomously; no human in the loop
```

---

## Core Pillars

| Pillar | What It Does | How To Use |
|--------|--------------|-----------|
| 🧠 **Remember** | Persistent memory across sessions — facts auto-ranked by recency, access frequency, semantic match, and importance. Entity graph to find related knowledge. Auto-consolidation to kill duplicates. | MCP: `oracle_memory_*` tools. CLI: `oracle memory list/search/update/consolidate`. Agent sees memory auto-injected into context. |
| 💬 **Consult** | Ask a question with your real project context (code files + memory + docs + web search/fetch). Get a cited answer back. | MCP: `oracle_ask`. CLI: `oracle ask "question" -f "src/**/*.ts"`. Agent can search memory, read files, fetch URLs, then answer. |
| 🛠️ **Act** | Autonomous agent with bash tool + file R/W + plan mode + self-review + resume. **Sandbox: shell + filesystem, confined to workspace.** Full audit trail of every mutation (who, when, what changed, hash). | MCP: `oracle_agent`. CLI: `oracle agent "write a test for X" --plan --review`. Agent loops until done; logs all file changes. |
| 📨 **Coordinate** | SQLite message bus for local sessions plus authenticated Remote Swarm rooms across machines. Messages, replies, acknowledgements, presence, and task events are durable. | Local: `oracle_msg_*` / `oracle msg ...`. Remote: `oracle connect`, `oracle team ...`. |
| ✅ **Verify** | Durable task/message coordination: lifecycle notifications are persisted before delivery, linked back to their Task and Swarm, and recover safely without duplicates. Checklist submit still **blocks** while verification is incomplete. | MCP: `oracle_task_*`, `oracle_coordination_recover`. CLI: `oracle task ...`, `oracle swarm .../recover`. |
| ⏰ **Runtime** | Persistent daemon owning SQLite coordination, Scheduler, token-scoped Remote Swarm API, and replayable WebSocket events. | CLI: `oracle daemon start/status/events/stop`, `oracle schedule ...`, `oracle team ...`. |
| 🖥️ **Control** | Human control plane with approval inbox, task workflow, memory distribution, audit visualization, agent presence, and scheduler management. WebSocket live updates with auto-reconnect. Per-tab actions: submit/close tasks, run/pause/delete scheduler jobs, memory maintenance. | TUI: `oracle control`. Web: `oracle control url`. Decisions: `oracle approval ...`. |

---

## Quick Start

### Install

```bash
# From npm
npm install -g @oraclepersonal/oracle
oracle doctor                # verify a provider is set up

# From source (development)
git clone https://github.com/OraclePersonal/Oracle.git
cd Oracle
npm install && npm run build
node dist/cli.js doctor
```

Start the local control plane:

```bash
oracle daemon start
oracle control              # interactive terminal UI (7 tabs, live updates, per-tab actions)
oracle control url          # authenticated web dashboard (approvals, tasks, scheduler, agents, audit)
```

### Wire up an MCP client

**Claude Code:**
```bash
oracle setup-mcp --client claude-code
```

This generates `.claude/mcp.json` with the config. Restart Claude Code; you'll see `oracle_*` tools appear.

**opencode or any MCP client:**
```json
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["-p", "@oraclepersonal/oracle", "oracle-mcp"],
      "env": {
        "ORACLE_WORKSPACE_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

### Set a model provider

```bash
export ANTHROPIC_API_KEY=sk-...    # or OPENAI_API_KEY, etc.
oracle doctor                       # verify it works
```

Supported: `anthropic`, `openai`, `opencode`, `codex`

### Connect agents on different machines

On the Runtime host:

```bash
oracle daemon start --remote --host 0.0.0.0
oracle team token --project clew-code --agent claude-lead --role lead
oracle team token --project clew-code --agent codex-worker --role worker
```

On each agent machine, use its own token:

```bash
oracle connect https://oracle.example.com \
  --project clew-code \
  --agent codex-worker \
  --token "$ORACLE_SWARM_TOKEN"
oracle team status
oracle team inbox
oracle team task list --active
```

Use HTTPS through a reverse proxy or an encrypted private network when the
Runtime crosses machine boundaries. Remote Swarm carries coordination data
only; it does not expose remote shell or file mutation endpoints.

---

## Core Features

### 1. Persistent Memory (ML-Ranked Retrieval)

Every `oracle_memory_*` call updates the knowledge graph. Future queries auto-rank by:
- **Recency** — accessed/updated recently? Rank higher.
- **Frequency** — used often? Rank higher.
- **Semantic match** — similar to the query? Rank higher.
- **Importance** — manually set, or promoted automatically if used frequently.
- **Entity graph** — "Service X" links to "connection pool Y"; expanding queries finds both.

Auto-consolidation: finds overlapping memories by tag similarity (Jaccard ≥ 0.3) and merges them.

To keep memory fast and inexpensive, Oracle normalizes tags, rejects exact duplicate content before writing, and uses local token-overlap ranking when embeddings are unavailable. These paths make no model or embedding request.

Background maintenance runs every 1 hour (tunable): consolidate, prune stale low-value memories, promote frequently-used working memories to durable insights.

**Memory scopes:** project memory is stored at `<workspace>/.oracle-memory/` and stays isolated to that work. Shared, cross-project memory is stored at `~/.oracle/memory/`. Memory MCP tools use `scope: "project"` by default; pass `scope: "global"` only for durable cross-project knowledge such as team conventions or agent roles.

### 2. Consultation Engine

`oracle ask` (or `oracle_ask` MCP tool) is a one-shot Q&A. You ask a question, and Oracle:
1. Reads your **tone** from the question (auto-picks a personality: engineer, socratic, playful, etc.)
2. Includes relevant **memory** (semantic search + entity graph)
3. Searches your **docs** (if configured)
4. Runs **web search/fetch** (if enabled)
5. Reads **code files** (if specified via `-f` glob)
6. Fetches **GitHub PR/issue context** (if linked)
7. Passes all of that to a model provider → gets a grounded answer with citations

**CLI:**
```bash
oracle ask "why is this service timing out?"
oracle ask "review this code" -f "src/handlers/**/*.ts"
oracle ask "what's in our latest PR?" --include-gh
```

**MCP:** `oracle_ask { question, files?, soul?, ... }`

### 3. Autonomous Agent (Sandbox + Audit Trail)

`oracle agent` is an **agentic tool-use loop** that reads/writes files and runs shell commands to complete a task autonomously. It:

- **Has a bash tool.** Runs shell commands via `exec()` respecting `$SHELL`, with the workspace as its working directory, policy checks, approval gates for risky commands, configurable timeout, and a full audit trail. Use an OS/container sandbox when host-level isolation is required.
- **Can plan before acting** (`--plan`). Runs a read-only investigation pass first, shows you the plan, then asks for confirmation before executing. Skip confirmation with `--yes`.
- **Self-reviews its own work** (`--review`). After the task completes, runs a second pass to check for correctness bugs, missing error handling, security issues, and edge cases.
- **Can resume from a checkpoint** (`--resume <id>`). If the loop hits `--max-steps` or crashes mid-way, it saves a checkpoint every turn. Resume where it left off without starting over. List checkpoints with `oracle agent-checkpoints`.
- **Pauses before risky actions.** The Human Control Plane stores the pending tool batch, requests an authorized quorum, verifies its payload hash, claims execution once, and resumes from the same checkpoint.
- **Outputs structured JSON** (`--json`). Get `finalText`, `steps`, `checkpointId`, and full audit trail of mutations.
- **Is fully audited.** Every file write is logged with timestamp, agent name, SHA256 hash, and diff summary. Audit can be replayed or reviewed.
- **Runs until done.** Loops — reads files, learns from test failures, edits, runs again — until it declares success or hits `--max-steps`.

**CLI:**
```bash
oracle agent "add error handling to src/handler.ts, test it, commit"
oracle agent "refactor the auth module" --plan               # plan → confirm → execute
oracle agent "fix the login bug" --review                     # execute → self-review
oracle agent "add input validation" --json                    # JSON output
oracle agent "finish the task" --resume cp-20260723-...       # resume from checkpoint
oracle agent "deploy" --approval-mode all-mutations           # gate every mutation
oracle agent --read-only "investigate the codebase" --json    # read-only + JSON
oracle agent-checkpoints                                      # list checkpoints
oracle agent-checkpoints --json                               # checkpoints as JSON
```

**MCP:** `oracle_agent { task, soul?, ... }`

### 4. Inter-Agent Coordination (Message Bus)

**The problem Oracle solves:** Two Claude Code sessions run in parallel. One finishes a refactor. How does the other know? How do they coordinate without you being the messenger?

**Solution: Shared SQLite message bus in `~/.oracle/runtime/oracle.db`**

Every agent can:
- **Register** (`oracle_msg_register`) — one call: register name/role → get the roster + your unread messages. Presence updates automatically.
- **Send** (`oracle_msg_send`) — to one agent, or broadcast (`to: "*"`) to all.
- **Receive** (`oracle_msg_inbox`) — see messages for you; filter by read/unread; limit results.
- **Reply** in **threads** (`replyTo`) — keeps conversation organized.
- **Ack** (`oracle_msg_ack`) — mark handled so Stop hook doesn't re-trigger.

**Key:** MCP server sends **instructions** to every client on connect:
> *"Before starting work: (1) register with oracle_msg_register (name + role). (2) Check your unread messages. (3) Handle anything urgent. Then proceed."*

No human has to say "go check your messages." The agent learns the pattern from instructions alone.

**Wake-up mechanics (4 tiers):**
1. **Pull** — Agent calls `oracle_msg_inbox` when it feels like it.
2. **Standby (blocking wait)** — `oracle_msg_inbox { wait: true, timeoutSeconds: <=600 }` blocks until a message arrives; on `waitTimedOut: true` the agent re-arms. Zero config — just tell a session to "stand by for messages".
3. **Push-on-idle (Stop hook)** — When Claude finishes a turn and tries to stop, the hook checks for unread messages. If any, it blocks the stop → Claude reads/acks → then can close.
4. **Real-time push (watcher)** — wakes a fully idle session: `scripts/oracle-tmux-launch.sh <agent>` starts Claude + watcher in tmux (or `oracle msg watch --exec` for a custom nudge). The watcher types into the pane the moment a message lands.

**CLI:**
```bash
oracle msg send -f lead -t worker -b "review this" --body-file findings.txt
oracle msg inbox -a worker --json --wait --timeout 120
oracle msg ack -a worker <id>
oracle msg watch -a codex --exec 'notify-send "Message from $ORACLE_MSG_FROM"'
```

**Storage:** messages, acknowledgements, and presence use transactional SQLite.
Legacy `~/.oracle/messages/*.json` and `~/.oracle/agents/*.json` data is
imported once and kept as a recovery copy.

### 5. Task Planning, Tracking & Verification (built on the message bus)

**The problem:** messaging alone doesn't give you accountability. Nothing
stops an agent from claiming "done" without actually finishing, and nothing
tracks who's responsible for what or what happened along the way.

**Solution: a task tracker layered on top of the bus**, with a lifecycle —
`pending → in_progress → review → done` (or `blocked`/`cancelled`) — and a
hard verification gate:

- **Create & assign** (`oracle_task_create`) — a lead breaks work into tasks,
  each with an assignee and an optional checklist of concrete verification
  steps. Auto-messages the assignee.
- **Track progress** (`oracle_task_update`) — the assignee logs status
  changes and notes as they work; this is the audit trail, not just an
  end-of-task summary.
- **Verify before reporting** (`oracle_task_checklist` + `oracle_task_submit`)
  — the assignee checks off each item as it's genuinely done. Submitting for
  review **fails** if anything is still unchecked — an agent cannot report
  done prematurely.
- **Report to the lead automatically** — a successful submit messages the
  task's creator with the summary; no separate "I'm done" message needed.
- **Close it out** (`oracle_task_close`) — the reviewer approves (→ `done`,
  assignee notified) or rejects with a note (→ back to `in_progress`,
  assignee notified with what's missing).

**CLI:**
```bash
oracle task create --title "Add rate limiting" --created-by lead --assignee builder \
  --checklist "implement limiter" "add tests" "update docs"
oracle task update <id> -a builder --status in_progress --note "starting"
oracle task check <id> 0        # check off item 0 as done
oracle task submit <id> -a builder --summary "limiter implemented, tested, documented"
oracle task close <id> -a lead                        # approve
oracle task close <id> -a lead --reject --note "..."  # send back
oracle task list --assignee builder --active
oracle swarm recover                                  # replay interrupted notifications
```

**Storage:** tasks and their deterministic coordination messages use SQLite.
Legacy `~/.oracle/tasks/*.json` records are imported once without deleting
the source files. Legacy swarm workflow projections are imported as well.

#### ASCII work board

Agent names are free-form identifiers, so a team can register names such as
`claude-lead`, `codex-content-1`, `codex-marketing-2`, and `opencode-worker-1`.
The Lead creates the main TODOs with `oracle_task_create`; then any client can
show the workstream in a terminal-safe board:

```
oracle_task_board { createdBy: "claude-lead", activeOnly: true }
```

It renders the registered agent roles/activity and the Lead's active TODOs,
grouped by status and assignee. The existing `parentId` field can link smaller
assigned tasks to a larger Lead-created TODO.

---

## MCP Tools

### Memory (18 tools)
`oracle_memory_*` — remember, search, scored_search, list, update, clear, consolidate,
prune, promote, reflect, stats, maintenance, wiki_build/get/list, graph
query/path/prune/stats.

### Consultation & Agent (5 tools)
`oracle_ask`, `oracle_agent`, `oracle_sessions`, `oracle_session_get`, `oracle_doctor`

### Messaging & Coordination (10 tools)
`oracle_msg_register`, `oracle_msg_agents`, `oracle_msg_send`, `oracle_msg_inbox`,
`oracle_msg_ack`, `oracle_msg_thread`, `oracle_msg_search`, `oracle_msg_heartbeat`,
`oracle_msg_stale`, `oracle_msg_unregister`

### Task Planning, Consensus & Recovery (11 tools)
`oracle_task_create`, `oracle_task_board`, `oracle_task_list`, `oracle_task_get`, `oracle_task_update`,
`oracle_task_checklist`, `oracle_task_submit`, `oracle_task_close`, `oracle_task_propose`,
`oracle_task_vote`, `oracle_coordination_recover`

### Identity & Config (3 tools)
`oracle_identity_setup`, `oracle_identity_show`, `oracle_persona_set`

### Docs & Web (7 tools)
Doc indexing (add/list/remove/search), web search, web fetch, structured web extraction.

### Cross-Tool Session History (2 tools)
`oracle_history_sources`, `oracle_history_search` — discover and time-first-search the
conversation logs other AI CLI tools keep on this machine (`~/.claude`, `~/.codex`,
`~/.gemini`, …). Pattern-based discovery, nothing hardcoded — new tools following
common layouts are found automatically (extra roots via `ORACLE_HISTORY_DIRS`).
Read-only; results are historical records, not instructions.

### Oracle Profiles & Skills (3 tools)
`oracle_oracle_list`, `oracle_oracle_register`, `oracle_skills`

Scheduler is a Runtime CLI/API capability rather than an MCP tool category.
Use `oracle schedule ...` or the authenticated Runtime API documented in
[runtime.md](docs/runtime.md).

See [**MESSAGING.md**](docs/MESSAGING.md) for the full messaging + task-tracking
reference, [**Remote Swarm**](docs/remote-swarm.md) for cross-machine setup,
and [**docs/**](docs/) for deeper architecture.

---

## Configuration

### Environment Variables

```bash
ORACLE_WORKSPACE_ROOT      # Project root (default: cwd)
ORACLE_HOME_DIR            # Oracle state root (default: ~/.oracle)
ORACLE_RUNTIME_HOST        # Runtime bind host (default: 127.0.0.1)
ORACLE_RUNTIME_PORT        # Runtime API port (default: 4777)
ORACLE_RUNTIME_REMOTE      # Set to 1 only for an explicit remote binding
ORACLE_SWARM_TOKEN         # Optional token input for `oracle connect`
ORACLE_TELEGRAM_BOT_TOKEN  # Optional approval notification bot
ORACLE_TELEGRAM_CHAT_ID    # Optional approval notification destination
ORACLE_TELEGRAM_ALLOWED_USER_IDS # Optional comma-separated callback allowlist
ORACLE_MEMORY_LLM_GRAPH    # Enable LLM-based memory graph reflection (default: off)
ANTHROPIC_API_KEY          # For Claude models (required if using Anthropic)
OPENAI_API_KEY             # For GPT (required if using OpenAI)
```

### Setup Steps

1. **Install:** `npm install -g @oraclepersonal/oracle`
2. **Provider:** Export `ANTHROPIC_API_KEY` (or your provider).
3. **Workspace:** `cd /path/to/project`
4. **MCP:** `oracle setup-mcp --client claude-code` (or wire manually).
5. **Identity:** `oracle identity setup` (optional; sets your name/preferences).
6. **Runtime:** `oracle daemon start` (optional; persistent scheduler/API).
7. **Test:** `oracle doctor`

---

## Architecture

```
Oracle MCP Server (src/mcp/)
├─ Consultation Engine (src/core/consult.ts)
│  └─ Reads workspace, memory, docs, web; asks a model
├─ Memory System (src/memory/)
│  └─ BM25 + vector search + entity graph + auto-consolidation
├─ Messaging Bus (src/messaging/)
│  └─ SQLite store + registry + watcher + CLI + onboarding hooks
├─ Task Tracker (src/tasks/)
│  └─ SQLite store + durable notification outbox
├─ Coordination Service (src/coordination/)
│  └─ Links Task ↔ Message ↔ Swarm, reconciles consensus, recovers workflows
├─ Agent Sandbox (src/agent/)
│  └─ File R/W, bash, approval gate, tamper-evident audit, resume, checkpoints
├─ Scheduler (src/scheduler/)
│  └─ CronEngine + repository port, owned by Runtime while active
├─ Runtime (src/runtime/)
│  └─ Daemon + SQLite + Remote Swarm + Scheduler + HTTP/WebSocket API
├─ Control Center (src/control/)
│  └─ Ink TUI + web dashboard + quorum/expiry/execute-once approvals +
│     WebSocket live updates, task/scheduler/memory actions
├─ Observability (src/observability/)
│  └─ Structured JSON logging to stderr
├─ Identity & Personas (src/identity/)
│  └─ Profile store + auto mood detection
└─ Skills & Oracles (src/skills/, src/oracles/)
   └─ Reusable skill registry + custom oracle profiles

CLI (src/cli.ts)
├─ oracle ask, agent, daemon, memory, msg, task, team, identity, schedule, ...
├─ oracle agent: --plan, --review, --resume, --approval-mode, --json, --read-only
├─ oracle daemon: start, run, status, stop, events
├─ oracle connect + team: authenticated cross-machine coordination
├─ oracle control: TUI, url, snapshot
├─ oracle approval: request, list, show, approve, reject
├─ oracle schedule: list, add, update, remove, run, watch
├─ same SQLite bus as MCP
└─ designed for scripting & local use

Standalone Coordination Server (src/mcp-messaging.ts)
├─ 10 oracle_msg_* + 10 oracle_task_* + oracle_coordination_recover
├─ No provider/memory/agent stack
└─ for agents that only need to coordinate, not consult or act
```

**Storage Layout:**
```
~/.oracle/
├─ runtime/
│  ├─ oracle.db           # Messages, tasks, agents, Remote Swarm, events, approvals
│  ├─ daemon.json         # Local endpoint + owner-only API credential
│  └─ daemon.log          # Background daemon output
├─ remote.json            # Current Remote Swarm profile (owner-only)
├─ messages/              # Legacy import source; retained if it existed
├─ tasks/                 # Legacy import source; retained if it existed
├─ agents/                # Legacy import source; retained if it existed
├─ swarms/                # Legacy workflow import source; retained if it existed
├─ scheduler/             # Legacy JSON tasks (import source)
├─ memory/                # Persistent memory (facts, insights, wiki, graph)
├─ skills/                # Local skill definitions
└─ .sessions/             # Session cache
```

---

## Security Model

### Agent Sandbox (Shell Confined)

The agent has a **bash tool** for running shell commands within the workspace. It can also:
- Read files (via `Read` tool)
- Write files (via `Write` / `Edit` tools)
- Spawn other agents via MCP

The bash tool is:
- **Confined** to the workspace root (paths escaping it are rejected)
- **Timed out** (default 120s per command)
- **Audited** (every command logged with exit code and truncated output)
- **Disabled in readOnly mode** — passing `readOnly` drops the bash tool entirely

### Audit Trail

Every file mutation (write/edit/delete) is logged:
```json
{
  "timestamp": "2026-07-22T15:30:45.123Z",
  "agent": "claude-code",
  "file": "src/handler.ts",
  "action": "edit",
  "hash": "sha256:abc123...",
  "diff": "..."
}
```

Audits are immutable; they go to `~/.oracle/audits/` and can be replayed or reviewed.

### Message Bus Security

Local coordination is stored in an owner-only SQLite database. Remote Swarm
tokens are project- and agent-scoped; only SHA-256 token hashes are stored.
The remote API exposes coordination data, not shell or file mutation tools.
Oracle's HTTP server does not terminate TLS, so cross-machine deployments
must use HTTPS through a reverse proxy or an encrypted private network.

---

## Limitations & Known Issues

- **Memory store grows unbounded.** Prune old memories by hand or via `oracle memory prune`.
- **Remote Runtime does not terminate TLS.** Put it behind HTTPS or use an encrypted private network.
- **Remote execution is intentionally absent.** Remote Swarm distributes messages and verified tasks, not shell commands.
- **Stop hook is fragile.** If a hook dies or times out, Claude closes anyway. Make hooks fast (< 1 second).

---

## Testing

```bash
npm run test              # vitest run src
npm run typecheck        # tsc --noEmit
npm run build            # tsc -> dist/
```

366 tests cover messaging, memory, Remote Swarm, Runtime, agent sandbox, bash
tool, MCP integration, and Control Center.

---

## Contributing

This is a **single monorepo** (moved from multi-repo on 2026-07-18). Fork, branch, and open PRs against `main`. Each commit must:
- Pass `npm run typecheck && npm run test`
- Follow file mutation audit conventions
- Reference related docs or issues

**Development loop:**
```bash
npm install
npm run dev              # tsx src/cli.ts (hot reload)
npm run mcp             # tsx src/mcp.ts
npm run mcp:messaging   # tsx src/mcp-messaging.ts
npm run test            # watch mode: vitest
```

---

## Learn More

- [**Messaging Flow & Setup**](docs/MESSAGING.md) — How agents coordinate, wake-up tiers, CLI reference, troubleshooting.
- [**Skill System**](.claude/skills/oracle-messaging/SKILL.md) — Portable SKILL.md that teaches any agent how to use the bus.
- [**Architecture Deep-Dive**](docs/architecture.md) — System design, data flow, threat model.
- [**Agent & Autonomy**](docs/AGENT.md) — How the sandbox works, audit trail, limitations.

---

## License

MIT. Not affiliated with Oracle Corp or the Oracle database.

**Why is it called Oracle?** An oracle is something you *consult* — it remembers, knows, and answers. This project is that for your agents: a shared source of truth they return to, and a switchboard they use to reach each other.
