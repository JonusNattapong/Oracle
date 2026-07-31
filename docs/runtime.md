# Oracle Runtime 0.5.0

Oracle Runtime is a persistent local service that owns long-lived scheduling,
SQLite state, authenticated HTTP APIs, and WebSocket event streams. Loopback
is the default; Remote Swarm can be enabled explicitly for cross-machine
coordination.

## Start and inspect

```bash
oracle daemon start
oracle daemon status
oracle daemon events
oracle daemon stop

# Foreground mode for development or process supervisors
oracle daemon run
```

The default endpoint is `http://127.0.0.1:4777`. Pass `--port 0` to allocate
an available port. The daemon writes state to
`~/.oracle/runtime/daemon.json`, logs to `~/.oracle/runtime/daemon.log`, and
SQLite data to `~/.oracle/runtime/oracle.db`.

Runtime also serves Human Control Plane 0.5.0 for the workspace from which the
daemon was started:

```bash
oracle control
oracle control url
```

`oracle schedule watch` remains as a foreground alias for
`oracle daemon run`. Other `oracle schedule` commands automatically use the
daemon API while it is available and fall back to the same SQLite database
when the daemon is stopped.

## Scheduler service

```bash
oracle schedule add "tests" "*/5 * * * *" "npm test"
oracle schedule list
oracle schedule update <id> --status paused
oracle schedule update <id> --status active
oracle schedule run <id>
oracle schedule remove <id>
```

At first startup, legacy JSON records from `~/.oracle/scheduler/*.json` are
imported with `INSERT OR IGNORE`. The original files are left untouched, and
repeated startup is idempotent.

The SQLite schema stores local and remote coordination, scheduler tasks, run
history, approvals, semantic Companion presence and intents, Runtime metadata,
and replayable events. WAL mode and a busy timeout allow local CLI readers to
coexist with the daemon.

## Local API

Health is available without credentials:

```text
GET /health
```

Admin `/v1/*` routes require the bearer token kept in the daemon state file:

```text
GET    /v1/schedules
POST   /v1/schedules
GET    /v1/schedules/:id
PATCH  /v1/schedules/:id
DELETE /v1/schedules/:id
POST   /v1/schedules/:id/run
GET    /v1/events?after=<event-id>&limit=<n>
GET    /v1/companion/state
POST   /v1/companion/presence
POST   /v1/companion/evaluate
POST   /v1/companion/pause
POST   /v1/companion/resume
DELETE /v1/companion/presence
POST   /v1/daemon/stop
GET    /v1/control/snapshot
GET    /v1/control/approvals
POST   /v1/control/approvals
GET    /v1/control/approvals/:id
POST   /v1/control/approvals/:id/decision
POST   /v1/control/approvals/:id/execution/claim
POST   /v1/control/executions/:id/complete
POST   /v1/consult
GET    /v1/consult/:sessionId
POST   /v1/swarm/tokens
DELETE /v1/swarm/tokens/:token-id
```

`POST /v1/consult` accepts `question`, optional `files`, `backend`, `model`,
`systemPrompt`, `conversationId`, `previousResponseId`, `accountMemory`, and a `cwd` confined
to the daemon workspace. It uses the same bundle and secret-scanning path as
CLI and MCP. Browser Mode additionally
accepts `conversationId` to resume the latest native ChatGPT thread associated
with that logical conversation. Advanced clients may pass a validated
`previousResponseId` directly; for Browser Mode this is the HTTPS ChatGPT
conversation URL returned by the prior result.
Browser Mode also requires `experimental.browserMode` in the workspace config.
`accountMemory` is an explicit, account-global side effect supported only by
`chatgpt-browser`. It is limited to 2,000 characters and should contain only a
high-level fact or preference. The raw value is not persisted in Oracle's
session record; the result reports `accountMemoryRequested` and
`accountMemorySaved`.

With `backend: "chatgpt-browser"`, PNG/JPEG/WebP entries in `files` are
uploaded to ChatGPT. Returned `images` are metadata records for files stored in
the consult session's `artifacts/images/` directory; Runtime JSON does not
inline their base64 bytes. `artifactWarnings` reports non-fatal capture issues.
The MCP `oracle_ask` adapter additionally emits each stored file as a standard
MCP image content block.

Remote Swarm routes require a project-scoped agent token instead:

```text
POST   /v1/swarm/connect
POST   /v1/swarm/heartbeat
GET    /v1/swarm/status
GET    /v1/swarm/agents
POST   /v1/swarm/messages
GET    /v1/swarm/messages/inbox
POST   /v1/swarm/messages/ack
GET    /v1/swarm/tasks
POST   /v1/swarm/tasks
GET    /v1/swarm/tasks/:id
PATCH  /v1/swarm/tasks/:id
POST   /v1/swarm/tasks/:id/check
POST   /v1/swarm/tasks/:id/submit
POST   /v1/swarm/tasks/:id/close
```

The CLI reads the token internally. `oracle daemon status --json` deliberately
redacts it.

## WebSocket events

Connect to `/v1/events?token=<token>&after=<event-id>`. The optional `after`
cursor replays persisted SQLite events before live streaming begins.

Event types include:

- `daemon.started`, `daemon.stopping`
- `scheduler.started`, `scheduler.stopped`
- `scheduler.task.created`, `scheduler.task.updated`,
  `scheduler.task.removed`
- `scheduler.run.started`, `scheduler.run.completed`
- `companion.presence.updated`, `companion.presence.forgotten`
- `companion.intent.evaluated`, `companion.paused`, `companion.resumed`
- `approval.requested`, `approval.vote.recorded`, `approval.approved`,
  `approval.rejected`, `approval.expired`
- `approval.execution.claimed`, `approval.execution.completed`,
  `approval.execution.failed`
- `approval.notification.failed`

Use `oracle daemon events --after <id>` instead of handling the token
directly.

See [Oracle Situated Companion](companion.md) for semantic presence, decision
scoring, quiet hours, pause/forget controls, and the deliberate no-coordinate
boundary.

## Security boundary

Runtime only accepts `127.0.0.1`, `::1`, or `localhost` as its bind host.
It rejects `0.0.0.0` and external interfaces unless `--remote` is explicitly
passed. The admin API token, connection profiles, and state files are written
with owner-only permissions.

Remote Swarm tokens provide project authorization but not transport
encryption. Use a TLS reverse proxy or an encrypted private network; do not
expose the built-in HTTP listener directly to the public internet.

The `/control` HTML shell is non-sensitive, but every data request and
decision still requires the Runtime token. `oracle control url` passes that
token in a URL fragment so it is not included in the initial HTTP request.

## Environment

```text
ORACLE_HOME_DIR       Runtime root (default ~/.oracle)
ORACLE_RUNTIME_HOST   Loopback bind host (default 127.0.0.1)
ORACLE_RUNTIME_PORT   API port (default 4777)
ORACLE_WORKSPACE_ROOT Fixed Control Center project root (default startup cwd)
ORACLE_TELEGRAM_BOT_TOKEN Optional approval notification bot
ORACLE_TELEGRAM_CHAT_ID   Optional approval notification destination
ORACLE_TELEGRAM_ALLOWED_USER_IDS Optional callback user allowlist
```

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
