# Oracle CLI Reference

Single-page reference for every `oracle` subcommand. Each command maps to
one or more MCP tools of the same name.

## Global flags

```
-V, --version    output the version number
-h, --help       display help for command
```

## Commands

### oracle ask

Ask Oracle anything with full project context.

Stored project memory relevant to the question is recalled and included
automatically, so answers are grounded in what Oracle already knows instead of
being guessed. Pass `--no-memory` to skip the recall. The MCP `oracle_ask` tool
behaves the same way and takes `include_memory: false` for the same purpose.

```bash
oracle ask "Why is service X timing out?"
oracle ask "review this" -f "src/**/*.ts"
oracle ask "what's in our latest PR?" --include-gh
oracle ask "review" --soul engineer
oracle ask "review this" --remember "I prefer concise reviews" --backend chatgpt-browser
oracle ask "describe this image" -f "docs/assets/system-map.png" --backend chatgpt-browser
```

| Flag | Purpose |
|---|---|
| `-f, --files <glob>` | Include code files (supports `!exclude` patterns) |
| `--no-memory` | Answer without recalling stored project memory |
| `--web-search` | Turn on ChatGPT's Web search for this answer (`chatgpt-browser` only) |
| `--deep-research` | Turn on ChatGPT's Deep research; takes many minutes (`chatgpt-browser` only) |
| `--include-docs` | Inject `.oracle/docs/` knowledge base |
| `--include-gh` | Include GitHub PR/issue context |
| `--soul <name>` | Personality: `engineer`, `socratic`, `witty`, etc. |
| `--conversation <id>` | Multi-turn recall; continuation-capable backends also resume their native conversation |
| `--remember <text>` | Explicitly save a high-level fact/preference to the signed-in ChatGPT account (`chatgpt-browser` only) |
| `--scope <project\|global>` | Memory scope (default: project) |
| `--backend <name>` | Override the execution backend, including experimental `chatgpt-browser` |
| `--provider <name>` | Deprecated alias for `--backend` |
| `--json` | Output structured JSON |

---

### oracle browser

Manage the isolated Chrome profile used by experimental ChatGPT Browser Mode.

Use `oracle browser status --live` to open or reuse the isolated Chrome profile
and verify that it contains an authenticated ChatGPT account session rather
than a guest session.

If ChatGPT or an OAuth provider refuses sign-in in the automation-enabled
window, run `oracle browser login`. Oracle restarts only its isolated Chrome
profile without automation flags. Complete login, close that window, then run
`oracle browser status --live`.

```bash
oracle browser setup
oracle browser login
oracle browser status
oracle browser status --live
oracle browser open
```

Browser Mode must also be enabled with `experimental.browserMode` in
`.oracle/config.json`. See [browser-mode.md](browser-mode.md).

`--remember` changes account-global ChatGPT Saved Memory, not Oracle's project
memory. It is explicit per call; do not use it for secrets, code, or large
templates. Manage or delete saved items in ChatGPT Settings > Personalization.

For Browser Mode, `-f/--file` also uploads PNG, JPEG, and WebP images to the
ChatGPT composer. Generated images are stored under the consult session's
`artifacts/images/` directory and their paths are printed after the text answer.

---

### oracle agent

Autonomous coding loop — reads, writes, edits files, runs shell commands.

```bash
oracle agent "add a --verbose flag and update the README"
oracle agent "refactor auth" --plan --yes
oracle agent "fix login bug" --review
oracle agent "add validation" --json
oracle agent "continue" --resume cp-20260723-...
oracle agent "investigate" --read-only
oracle agent "deploy" --approval-mode risky
```

| Flag | Purpose |
|---|---|
| `--plan` | Read-only investigation pass, then confirm before executing |
| `--yes` | Skip confirmation prompt when using `--plan` |
| `--review` | Self-review pass after completion |
| `--resume <id>` | Resume from a saved checkpoint |
| `--json` | Structured output with `finalText`, `steps`, `checkpointId` |
| `--read-only` | No mutations; read-only investigation |
| `--approval-mode <mode>` | Override approval policy: `off`, `risky`, or `all-mutations` |
| `--max-steps <n>` | Cap the loop (default 20, max 50) |
| `--provider <name>` | Override provider for this run |
| `--model <name>` | Override model for this run |

Related: `oracle agent-checkpoints` — list or delete checkpoints.

---

### oracle governance (or oracle actb)

Display real-time ACTB Governance Framework (Awareness, Control, Transform, Boundary) status and policy metrics.

```bash
oracle governance
oracle actb --json
```

---

### oracle memory

Persistent memory management.

```bash
oracle memory remember "Dashboard uses connection pool Y"
oracle memory search "connection pool"
oracle memory list
oracle memory stats
oracle memory consolidate
oracle memory prune --days 30
oracle memory promote <id>
```

Select where durable memory lives — `local` (default, this machine),
`chatgpt` (the signed-in account's Saved Memory), or `hybrid` (local canonical
plus a mirror of high-importance entries):

```bash
oracle memory store
oracle memory store hybrid
```

`chatgpt` and `hybrid` require the `chatgpt-browser` backend and a signed-in
session. See the memory storage table in the README for the trade-offs.

Memories can carry Git anchors — the commit and blob sha of the files they
describe — so the store can tell when the code moved out from under them:

```bash
oracle memory verify --anchors            # sweep the store and report freshness
oracle memory reanchor <id> --type fact   # accept the current file as the new baseline
```

`verify` exits non-zero when an anchor points at a **missing** file, which makes
it usable as a CI or pre-commit gate:

```bash
oracle memory verify --anchors || echo "memory describes code that no longer exists"
```

**drifted** anchors (the file was edited) are reported but do not fail the
command — they fire on every commit touching an anchored file, so gating on them
would turn the check into noise. A drifted memory is still recalled, at reduced
confidence, until someone decides whether it is still true.

`reanchor` is that decision, and it is deliberately one entry at a time: it
asserts the memory still holds for the new code, which no sweep can determine.
It refuses to re-point an anchor whose file was deleted — rewrite or forget the
memory instead.

---

### oracle browser

Manage the isolated Chrome profile used by ChatGPT Browser Mode.

```bash
oracle browser setup            # create the profile and log in
oracle browser login            # re-open for manual login, no automation flags
oracle browser status --live    # verify the saved session
oracle browser status --selectors  # check the ChatGPT DOM handles still resolve
oracle browser open             # open ChatGPT in the Oracle profile
oracle browser stop             # close it and reclaim the memory
```

Browser Mode deliberately leaves Chrome running so consecutive consults reuse
one session. `oracle browser stop` closes it when that memory is worth
reclaiming; the profile and its ChatGPT login stay on disk, so the next consult
just starts a fresh instance. Running it when nothing is up is a no-op.

---

### oracle wiki

Compile memory into topic-grouped wiki pages.

```bash
oracle wiki build "auth"
oracle wiki list
oracle wiki get "auth"
```

---

### oracle docs

Manage `.oracle/docs/` knowledge base.

```bash
oracle docs list
oracle docs add README.md
oracle docs search "deployment"
oracle docs remove old-guide.md
```

---

### oracle web

Web search, fetch, and structured extraction.

```bash
oracle web search "Redis timeout causes"
oracle web fetch https://example.com/api-docs
oracle web extract https://example.com/pricing --schema price
```

Providers: Brave, Tavily, Firecrawl, AgentQL (auto-fallback).

---

### oracle msg

Inter-agent message bus.

```bash
oracle msg send -f lead -t builder -b "start the task"
oracle msg send -f lead -t "*" -b "team standup in 5"
oracle msg inbox -a builder
oracle msg inbox -a builder --wait --timeout 120
oracle msg ack -a builder <id>
oracle msg agents
oracle msg thread --reply-to <id> -b "done"
oracle msg watch -a builder --exec 'notify-send "msg from $ORACLE_MSG_FROM"'
```

---

### oracle task

Task planning, tracking, and verification.

```bash
oracle task create --title "Add rate limiter" --created-by lead --assignee builder \
  --checklist "implement" "add tests" "update docs"
oracle task list --assignee builder --active
oracle task get <id>
oracle task update <id> -a builder --status in_progress --note "starting"
oracle task check <id> 0                          # check off item 0
oracle task submit <id> -a builder --summary "done"
oracle task close <id> -a lead                    # approve
oracle task close <id> -a lead --reject --note "..."  # reject
oracle task board --created-by lead
```

Task lifecycle messages are linked persistently and can be replayed with
`oracle swarm recover` if a process stops between the task write and message
delivery.

---

### oracle companion

Local-first semantic presence and explainable self-initiated conversation.
Requires Oracle Runtime to be running.

```bash
oracle companion status [--json] [--limit 5]
oracle companion presence home --source geofence --confidence 0.9 --ttl 180
oracle companion evaluate [--json]
oracle companion pause [--minutes 60]
oracle companion resume
oracle companion forget
```

Local notification delivery, disabled until enabled explicitly:

```bash
oracle companion channels [--json]
oracle companion channel enable windows-toast
oracle companion channel disable windows-toast
oracle companion notify-test [--json]
oracle companion deliveries [--json] [--limit 10]
```

Only semantic states are accepted; raw coordinate fields are forbidden. Silence
is never delivered, an intent is delivered at most once per channel, and a
cooldown prevents repeated notifications. See [Situated Companion](companion.md)
for scoring, quiet hours, TTL, delivery gates, and privacy boundaries.

---

### oracle schedule

Runtime-backed cron task scheduler.

```bash
oracle schedule list
oracle schedule add "daily-backup" "0 2 * * *" "tar czf /tmp/backup.tgz src/"
oracle schedule update <id> --cron "*/10 * * * *"
oracle schedule update <id> --status paused
oracle schedule run <id>            # run once immediately
oracle schedule watch               # foreground Runtime compatibility alias
oracle schedule remove <id>
```

---

### oracle connect / oracle team

Connect agents on different machines to one project-scoped Remote Swarm.

```bash
# Runtime host
oracle daemon start --remote --host 0.0.0.0
oracle team token --project clew-code --agent worker-1 --role worker
oracle team token-revoke <token-id>

# Agent machine
oracle connect https://oracle.example.com \
  --project clew-code --agent worker-1 --token "$ORACLE_SWARM_TOKEN"
oracle team status
oracle team agents
oracle team send --to lead --body "Ready"
oracle team inbox
oracle team ack <message-id>
oracle team watch

oracle team task create --title "Tests" --assignee worker-1 \
  --checklist "tests pass"
oracle team task list --active
oracle team task update <id> --status in_progress --note "starting"
oracle team task check <id> 0
oracle team task submit <id> --summary "verified"
oracle team task close <id>
```

See [Remote Swarm](remote-swarm.md) for deployment and security guidance.

---

### oracle daemon

Persistent Runtime with SQLite coordination, Scheduler, HTTP APIs, and
WebSocket events.

```bash
oracle daemon start [--port 4777]
oracle daemon start --remote --host 0.0.0.0  # explicit Remote Swarm binding
oracle daemon status [--json]
oracle daemon events [--after <event-id>]
oracle daemon stop
oracle daemon run                    # foreground mode
```

---

### oracle control

Control Center TUI and local web dashboard.

```bash
oracle control                       # interactive TUI
oracle control --plain               # dependency-free ANSI fallback
oracle control --once                # render once and exit
oracle control --actor lead          # record TUI decisions as lead
oracle control url                   # print authenticated dashboard URL
oracle control snapshot              # JSON projection
```

---

### oracle approval

Persistent human approval inbox.

```bash
oracle approval list [--status pending]
oracle approval show <id>
oracle approval request --title "Deploy" --requested-by builder \
  --assigned-to lead --reviewers lead,security --quorum 2 \
  --expires-in 30 --kind command --risk high --local-only
oracle approval approve <id> --by lead --note "verified"
oracle approval reject <id> --by lead --note "needs changes"
```

Tasks submitted for review appear automatically. Their decisions reuse the
existing TaskStore and CoordinationService transition.

---

### oracle swarm

Autonomous multi-agent swarm workflow.

```bash
oracle swarm create "Build the dashboard feature" \
  --architect lead --coder builder --reviewer reviewer --qa tester
oracle swarm propose <workflow-id> builder "Implement the dashboard"
oracle swarm vote <proposal-id> reviewer approve "review passed"
oracle swarm vote <proposal-id> tester approve "tests passed"
oracle swarm status
oracle swarm recover
```

---

### oracle audit

View agent audit trail and policy violations.

```bash
oracle audit show --limit 50
oracle audit violations
oracle audit verify
oracle audit verify --json
```

---

### oracle identity

Manage your personal identity profile.

```bash
oracle identity setup
oracle identity show
oracle identity awareness
```

`oracle identity awareness` prints Oracle's derived self-awareness snapshot:
its persona and role, configured operator, active workspace and backend,
available capability classes, and the boundaries it must respect.

---

### oracle skill

Manage skills.

```bash
oracle skill list
oracle skill info <name>
```

---

### oracle doctor

Verify installation, config, and provider health.

```bash
oracle doctor
```

---

### oracle setup-mcp

Generate MCP config for a client.

```bash
oracle setup-mcp --client claude-code
```

---

### oracle login / logout

OAuth authentication.

```bash
oracle login --provider anthropic
oracle logout --provider anthropic
```

---

### oracle session

View consultation history.

```bash
oracle session <id>
```

---

### oracle oracle

Manage oracle profiles (skill + model + memory bundles).

```bash
oracle oracle list
oracle oracle register --name coding --skill review --model auto
```

---

### oracle github

GitHub integration via `gh` CLI (requires `gh auth status`).

```bash
oracle github pr list --repo owner/repo
oracle github pr get 42 --repo owner/repo
oracle github pr diff 42 --repo owner/repo
oracle github pr review 42 --repo owner/repo --approve
```

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
