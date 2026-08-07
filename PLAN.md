# Oracle Concurrent Access — Corrected Plan

**Status:** Superseded original PLAN.md (2026-08-07 draft proposed a PostgreSQL +
JWT + Express rewrite; investigation below found that duplicates existing
infrastructure and is far larger than the actual problem)  
**Date:** 2026-08-07

## What the original plan got wrong

The original PLAN.md assumed Oracle had no server, no auth, and no shared
database, and proposed building all three from scratch. None of that is true:

| Original plan proposed | What already exists |
|---|---|
| Build Express HTTP server | `src/runtime/api.ts` — `LocalApiServer`, 1,055 lines, working, has `/v1/consult` |
| Build PostgreSQL schema | `src/runtime/database.ts` — `RuntimeDatabase`, SQLite in WAL mode already |
| Build JWT + OAuth device flow | Bearer/`x-oracle-token` auth already in `LocalApiServer.authorized()` |
| Build an audit table | `src/observability/audit.ts` — `AuditLogger`, hash-chained, tamper-evident, `agentId` attribution, already wired to `--agent <name>` on `oracle ask` |
| Build a REST API | Already exists (`/v1/consult`, `/v1/schedules`, `/v1/swarm/*`, `/v1/control/*`) |

Implementing the original plan would have built a second, competing HTTP+auth+DB
stack alongside the one already running in production.

## What is actually broken

Two things — and the second was found by testing the first fix live, not by
inspection. It is more damaging than the first.

1. **`ChromeLauncher.launch()` has a check-then-act race.** It reads
   `DevToolsActivePort`, probes whether the endpoint is alive, and — if not —
   deletes the marker and spawns a new Chrome. Two processes doing this at the
   same moment (three users each running `oracle ask` at once) can both decide
   "no live Chrome" and both spawn one onto the same profile directory. This is
   the same class of bug fixed once already today for the *single-user* case
   (commit `7b2bb96`, which widened the reuse-probe timeout) — but that fix
   does nothing for two processes racing at the same instant, because probing
   slower does not make the read-then-write atomic. **Fixed** with a
   cross-process lock (`withLaunchLock`).

2. **Fixing #1 exposed a second, worse bug.** `findOrCreatePageTarget` finds
   whichever `chatgpt.com` tab is already open and reuses it — correct for one
   user's continuity across turns, but with #1 fixed, three concurrent
   requests now correctly share *one Chrome instance* and then all drive the
   *same tab*: one process's prompt gets typed while another is mid-read, all
   three read from a single response stream. Live-tested before this was
   understood: three concurrent `oracle ask` calls with three different
   questions returned **the same wrong answer to all three** — silently, with
   exit code 0, no error. A hang would have been the safer failure. **Fixed**
   with a second lock (`withConsultLock`) held for the full request — launch
   through final read, retries included — so concurrent requests queue rather
   than interleave on the tab.

## The fix

Two cross-process advisory locks, both using the same exclusive-create +
stale-detection pattern already proven in this codebase
(`AuditLogger.withLock()` in `src/observability/audit.ts`):
`fs.open(path, "wx")`, poll-with-backoff on `EEXIST`/`EPERM`, stale-lock
detection via mtime, release on completion. Extracted into a shared
`withFileLock` primitive in `chrome.ts` since two independent locks were
needed over the same profile directory — reusing one lock file for both would
deadlock a caller against itself, since `run()` holds the outer lock while
its own call chain reaches `launch()`'s inner one.

- [x] `withLaunchLock` — the launch-time race (per profile, `.launch.lock`)
- [x] `withConsultLock` — the tab-sharing race (per profile, `.consult.lock`,
      held for the whole request including retries)
- [x] `chrome.test.ts` — 6 tests: serialization, result propagation,
      lock release on throw, stale-lock recovery, and that the two locks
      don't block each other unnecessarily
- [x] Full suite: 694 tests pass, no regressions
- [x] Live-verified: 3 concurrent `oracle ask` calls with distinct prompts,
      before the fix → identical wrong answer to all three; after → each
      received its own correct answer (ALPHA / BETA / GAMMA), serialized at
      roughly 30s each rather than corrupted

**Known trade-off, accepted deliberately:** concurrent browser-backend
requests are now serialized, not parallel. This is the correct behavior for
one shared ChatGPT tab, not a shortcut — true parallelism would need either
one Chrome profile per concurrent user (resource-heavy) or one tab per
request (breaks the continuity `findOrCreatePageTarget` exists to provide).
Neither was in scope for "stop it from returning wrong answers."

**Known gap, not yet addressed:** `ChatGptBrowserBackend.listAccountMemories`
also drives the shared tab (navigates, reads memory) and is not covered by
`withConsultLock`. Lower priority — it's a diagnostic path, not the main
`ask` flow that was reported and reproduced — but a `run()` call and a
`listAccountMemories()` call in flight at the same time would still race.

## Explicitly out of scope (not needed to fix the actual bug)

- PostgreSQL migration — SQLite WAL already handles this write volume; revisit
  only if the daemon needs to run on a machine PostgreSQL is already the
  standard for, not because SQLite can't take three users
- New auth system — `Authorization: Bearer` already exists on the daemon; a
  per-human-user identity system is a real feature but is unrelated to the
  Chrome race and should be scoped separately if a shared multi-tenant daemon
  is actually wanted
- CLI → HTTP client rewrite — not required for correctness; revisit if/when
  centralizing session state across a team becomes the actual goal
- systemd packaging, health-check endpoints — daemon lifecycle already has
  `oracle daemon start/stop/status`; no evidence this is the current problem

## If real multi-tenant server mode is wanted later

That is a legitimate, separate feature (share memory across a team, one
daemon serving multiple physical machines) — but it is not what "three
people running Oracle on the same machine at the same time" requires, and it
deserves its own plan written after this fix is validated in use, not before.
