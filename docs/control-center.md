# Oracle Human Control Plane 0.5.0

Control Center is Oracle's local human control plane. It combines an
authorization-aware approval inbox, resumable agent checkpoints, an
execute-once action gate, task and agent state, memory, scheduling, a
tamper-evident audit chain, and live WebSocket-driven updates.

Runtime remains local-first: HTTP and WebSocket listeners bind only to
loopback and every data or mutation route uses the owner-only Runtime token.

## Start

```bash
cd /path/to/project
oracle daemon start
oracle control
```

The directory used to start Runtime is the fixed Control Center workspace.
Restart Runtime from another project to change it.

## Interactive TUI

`oracle control` uses Ink and provides seven tabs:

- Overview
- Approvals
- Tasks
- Memory
- Audit
- Agents
- Scheduler

The TUI connects to Runtime via WebSocket for live updates. A connection
status indicator (`● LIVE` in green, `○ POLL` in yellow) appears in the
header. When Runtime is unreachable it falls back to polling every 10
seconds and reconnects automatically.

Keyboard controls and per-tab actions:

- `←`/`→` or Tab — change tab
- `j`/`k` or up/down — move selection (per-tab, separate for each tab)
- Enter on Approvals — show or hide approval details
- `/` — filter approvals (Approvals tab only)
- `a` — open approval confirmation (Approvals tab only)
- `x` — enter a rejection reason, then confirm (Approvals tab only)
- `s` — submit selected task for review (Tasks tab, in_progress/pending/blocked)
- `c` — close selected task (Tasks tab, review status)
- `r` on Scheduler — run selected job now (Scheduler tab)
- `p` — pause or resume selected job (Scheduler tab)
- `d` — delete selected job (Scheduler tab, with confirmation)
- `m` — run memory maintenance (Memory tab)
- `r` — refresh snapshot
- `q` — quit

Use `--actor <identity>` to select the decision identity. It must match an
authorized reviewer on the request. The dependency-free renderer remains
available for minimal terminals and automation:

```bash
oracle control --plain
oracle control --once
oracle control snapshot
```

## Web dashboard

```bash
oracle control url
```

The printed URL carries the Runtime credential in its fragment. The dashboard
moves it to tab-scoped session storage and removes it from the address bar.
Do not share this URL.

The dashboard now includes:

- **Approval inbox** with client-side filter input, approve/reject buttons,
  risk badge, quorum progress, and expiry display
- **Task workflow** with 6-status lane counts, task table (status, title,
  owner→agent, updated), and inline Submit / Close action buttons
- **Scheduler** job table with Run, Pause/Resume, and Delete buttons per row
- **Agents** presence list with active/stale dots, name, role, and relative
  last-seen timestamps
- **Memory distribution** bar chart (by type) with a Run maintenance button
- **Audit activity** event timeline with chain integrity badge
- **Toast notifications** for non-disruptive feedback on actions
- Live WebSocket updates with debounced reload (250ms); offline/polling
  indicator in the header
- Relative `Updated X ago` timestamp in the header
- Dark/light theme toggle; responsive layout down to mobile widths

Dashboard decisions submit the approval version displayed on screen. A stale
page receives a conflict instead of overwriting a newer vote.

## Durable approval contract

## Durable approval contract

Every approval records:

- authorized reviewer identities
- required quorum and immutable vote history
- optimistic-lock version
- optional expiry
- optional action payload and SHA-256 canonical payload hash
- linked task, workflow, message, and agent checkpoint
- local-only policy for remote channels

Rejection finalizes immediately. Approval finalizes only after the configured
number of different authorized reviewers vote. Duplicate, stale, unauthorized,
expired, and replayed decisions are rejected.

```bash
oracle approval request \
  --title "Deploy release" \
  --description "Verification passed" \
  --requested-by builder \
  --assigned-to lead \
  --reviewers lead,security \
  --quorum 2 \
  --expires-in 30 \
  --kind command \
  --risk high \
  --local-only

oracle approval list
oracle approval show <approval-id>
oracle approval approve <approval-id> --by lead --note "verified"
oracle approval approve <approval-id> --by security
oracle approval reject <approval-id> --by lead --note "needs rollback plan"
```

Tasks entering `review` still create one approval per review cycle. Their
final decision uses the existing CoordinationService so TaskStore and linked
messages stay consistent.

## Agent execution gate and recovery

The default `risky` policy pauses high-risk shell actions such as pushes,
publishes, deployments, infrastructure changes, remote connections, service
changes, and destructive commands.

When a gate is reached Oracle:

1. stores the complete pending tool batch in a checkpoint;
2. creates a Runtime approval whose canonical action is hashed;
3. exits without running the guarded tool;
4. verifies the same payload after approval;
5. atomically claims the approval execution once;
6. runs the tool, records its result, and resumes the model loop.

```bash
oracle agent "publish the verified release"
oracle agent-checkpoints
oracle approval approve <approval-id> --by lead
oracle agent "publish the verified release" --resume <checkpoint-id>
```

If Runtime is unavailable, the agent still saves a waiting checkpoint and
fails closed. Start Runtime and resume the checkpoint.

Configure `.oracle/policy.json`:

```json
{
  "approval": {
    "mode": "risky",
    "reviewers": ["lead", "security", "telegram:123456789"],
    "highRiskQuorum": 2,
    "expiryMinutes": 30,
    "allowTelegramHighRisk": false
  }
}
```

Modes are `off`, `risky`, and `all-mutations`. A one-run override is available
through `oracle agent ... --approval-mode <mode>`.

## Tamper-evident audit

New audit records contain a monotonic sequence, previous hash, and SHA-256 hash
over canonical record content. A persisted head anchor detects tail truncation,
and a short cross-process file lock serializes writers.

```bash
oracle audit show
oracle audit verify
oracle audit verify --json
```

Logs created before 0.4.0 remain readable and are reported as legacy unsigned
entries. Entries added after the chain starts are fully verified.

## Optional Telegram callbacks

Notifications require a bot token and chat. Callback decisions additionally
require an allowlist:

```bash
export ORACLE_TELEGRAM_BOT_TOKEN="..."
export ORACLE_TELEGRAM_CHAT_ID="123456789"
export ORACLE_TELEGRAM_ALLOWED_USER_IDS="123456789,987654321"
oracle daemon start
```

Use reviewer identities such as `telegram:123456789`. Runtime validates the
configured chat, Telegram user ID, approval token, expected version, reviewer
authorization, expiry, and duplicate-vote state. Callback tokens are random
and do not contain the approval ID. High-risk agent actions are local-only
unless `allowTelegramHighRisk` is explicitly enabled; quorum can still require
a separate local reviewer.

Bot credentials are read from the environment and never stored in SQLite,
audit records, daemon state, or Runtime events.

## Local API

All routes require the Runtime token:

```text
GET  /v1/control/snapshot
GET  /v1/control/approvals?status=pending
POST /v1/control/approvals
GET  /v1/control/approvals/:id
POST /v1/control/approvals/:id/decision
POST /v1/control/approvals/:id/execution/claim
POST /v1/control/executions/:id/complete
POST /v1/control/tasks/:id/submit          {"actor":"…", "summary":"…"}
POST /v1/control/tasks/:id/close           {"actor":"…", "note":"…"}
POST /v1/control/memory/maintenance
```

Decision bodies include `decidedBy`, `expectedVersion`, and an optional
channel/note. Execution claim bodies must provide the exact stored payload
hash. SQLite enforces one execution row per approval.

Related events include `approval.requested`, `approval.vote.recorded`,
`approval.approved`, `approval.rejected`, `approval.expired`,
`approval.execution.claimed`, `approval.execution.completed`,
`approval.execution.failed`, and `approval.notification.failed`.

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
