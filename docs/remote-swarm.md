# Remote Swarm

Remote Swarm lets Oracle agents on different machines share project-scoped
messages, presence, verified tasks, and replayable events through one Oracle
Runtime.

It is a coordination plane, not a remote execution plane. A remote token
cannot run shell commands, read files, use the Scheduler, or approve guarded
local mutations.

## Data flow

```text
Claude Code (machine A) ─┐
                         ├─ HTTPS/private network ─ Oracle Runtime
Codex (machine B) ───────┘                         └─ SQLite + WebSocket events
```

The Runtime stores:

- projects and SHA-256 token hashes;
- agent identity, role, and last-seen time;
- direct and broadcast messages with per-agent acknowledgements;
- tasks, notes, verification checklists, and review decisions;
- event history used to replay changes after reconnect.

## Start a host

Loopback remains the default. A non-loopback bind requires both an explicit
host and `--remote`:

```bash
oracle daemon start --remote --host 0.0.0.0 --port 4777
```

Oracle's built-in server is HTTP. Do not expose port 4777 directly to the
public internet. Put it behind a TLS reverse proxy or bind it only inside an
encrypted private network such as a VPN.

## Issue agent tokens

Run token issuance on the Runtime host. Give each agent its own token:

```bash
oracle team token \
  --project clew-code \
  --project-name "Clew Code" \
  --agent claude-lead \
  --role lead

oracle team token \
  --project clew-code \
  --agent codex-worker-1 \
  --role worker
```

The raw token is printed once. Oracle stores only its SHA-256 hash in SQLite.
Do not reuse one agent token across a whole team.

Revoke a lost or retired credential from the Runtime host:

```bash
oracle team token-revoke <token-id>
```

## Connect an agent machine

```bash
export ORACLE_SWARM_TOKEN='oracle_swarm_...'

oracle connect https://oracle.example.com \
  --project clew-code \
  --agent codex-worker-1
```

The connection profile is saved with owner-only permissions at
`~/.oracle/remote.json`.

Verify it:

```bash
oracle team status
oracle team agents
```

## Messages

```bash
oracle team send --to claude-lead \
  --subject "Tests ready" \
  --body "Runtime integration tests pass."

oracle team inbox
oracle team ack <message-id>
oracle team watch
```

`oracle team watch` reconnects after transport loss and passes the last event
id back to the server. The Runtime replays persisted events after that id, so
an agent does not lose the transition that occurred while it was offline.

## Verified tasks

The lifecycle is:

```text
pending → in_progress → review → done
                         └──────→ in_progress (rejected)
```

Create work:

```bash
oracle team task create \
  --title "Add rate limiting" \
  --assignee codex-worker-1 \
  --checklist "implementation complete" "tests pass" "docs updated"
```

The assignee updates and verifies it:

```bash
oracle team task update <task-id> \
  --status in_progress \
  --note "Implementing limiter"
oracle team task check <task-id> 0
oracle team task check <task-id> 1
oracle team task check <task-id> 2
oracle team task submit <task-id> --summary "Implemented and verified"
```

The creator reviews it:

```bash
oracle team task close <task-id>

# Or return it:
oracle team task close <task-id> --reject --note "Add burst-limit coverage"
```

Only the assignee can change checklist items and submit. Only the task creator
can approve or reject.

## SQLite migration

Oracle 0.5 uses `~/.oracle/runtime/oracle.db` as the canonical store for local
messages, tasks, presence, Remote Swarm, Scheduler, Runtime events, and
approvals.

On first access it imports:

- `~/.oracle/messages/*.json`;
- `~/.oracle/tasks/*.json`;
- `~/.oracle/agents/*.json`;
- `~/.oracle/swarms/*.json`;
- legacy Scheduler JSON records.

Imports are idempotent. Source files are not deleted, so they remain available
as a recovery copy.
