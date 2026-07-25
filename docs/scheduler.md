# Scheduled Cron Tasks

The `oracle schedule` command group uses the Runtime Scheduler service —
define, list, update, run, and remove persistent cron tasks. While
`oracle daemon` is running, commands go through its local API so the live
engine reschedules immediately.

## Data Storage

Tasks and run history are stored in `~/.oracle/runtime/oracle.db`. Existing
JSON tasks under `~/.oracle/scheduler/` are imported idempotently on daemon
startup and are not deleted.

## CLI Commands

### `oracle schedule list`

List all scheduled tasks with their status, cron expression, and last run result.

```
oracle schedule list
```

### `oracle schedule add <name> <cron> <command>`

Add a new scheduled task.

```
oracle schedule add "daily backup" "0 2 * * *" "pg_dump mydb > /tmp/backup.sql"
oracle schedule add -d "Run tests every 5 minutes" "tests" "*/5 * * * *" "npm test"
```

### `oracle schedule remove <id>`

Remove a scheduled task by its ID (shown in `list` output).

```
oracle schedule remove abc1234-5678-...
```

### `oracle schedule update <id>`

Update fields or pause/resume a task. Active cron registrations are replaced
immediately when Runtime is running.

```bash
oracle schedule update <id> --cron "*/10 * * * *"
oracle schedule update <id> --status paused
oracle schedule update <id> --status active
```

### `oracle schedule run <id>`

Run a scheduled task immediately (one-shot execution).

```
oracle schedule run abc1234-5678-...
```

Exit code matches the task result: `0` for success, `1` for error.

### `oracle schedule watch`

Compatibility alias for running the full Oracle Runtime in the foreground.

```
oracle schedule watch
```

Runs until interrupted (SIGINT/SIGTERM). Runtime events are available through
`oracle daemon events`.

```
oracle schedule watch --once
```

Run all active tasks once and exit (for one-shot execution or testing).

## Cron Expressions

Uses standard 5-field cron syntax via [`node-cron`](https://github.com/kelektiv/node-cron):

| Expression | Meaning |
|---|---|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour, on the hour |
| `0 2 * * *` | Every day at 2:00 AM |
| `0 0 * * 0` | Every Sunday at midnight |
| `30 14 1 1 *` | January 1st at 2:30 PM |

## Configuration

Runtime state is stored under `~/.oracle/runtime/`. See
[runtime.md](runtime.md) for the API, WebSocket, security, and daemon
lifecycle.

## Examples

Run a build on every push detected by a file watcher:

```
oracle schedule add "build on change" "* * * * *" "npm run build"
```

Nightly report generation:

```
oracle schedule add "nightly report" "0 6 * * *" "node scripts/report.js"
```

One-off test run:

```
oracle schedule run abc1234...
```

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
