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
   — see below; the first fix attempted (a profile-wide lock forcing full
   serialization) was superseded by a second one that achieves real
   parallelism instead of trading wrong answers for a queue.

## The fix

Two mechanisms, arrived at in two passes — the first was safe but not what
was asked for, and testing it live is what surfaced the requirement it
missed.

**Pass 1 (safe, serialized — superseded below).** A profile-wide lock
(`withConsultLock`) held for the whole request, so concurrent callers queue
rather than share a tab. Live-verified correct: three concurrent calls with
three different prompts each got their own right answer, ~30s apart rather
than corrupted. This closed the silent-wrong-answer bug completely, but the
ask was for parallel, and this is not — accepted as an intermediate state
while parallelism was investigated, not as the final answer.

**Pass 2 (parallel — what shipped).** Each request gets its own dedicated
Chrome **window**, not a shared tab and not even a shared *tab* — a same-window
dedicated tab was tried first and rejected by live testing: of three
concurrent tab-based requests, only the frontmost tab produced a real answer,
the other two timed out at 180s with no response at all. Live-confirmed cause:
`document.visibilityState` differs between a frontmost and a backgrounded tab
in the same window, and Chrome/ChatGPT do not process a background tab's work
the same way. A separate `Target.createTarget({ newWindow: true })` per
request does not have this problem — live-confirmed `document.hidden: false`
and `visibilityState: "visible"` in three simultaneously open windows.

With each request isolated to its own window, there is nothing left for
independent requests to share, so the profile-wide lock is gone. What remains
is narrower: `withConversationLock`, keyed by a hash of the conversation URL,
serializes only requests that continue the *same* existing thread (two windows
posting into one ChatGPT conversation is still not something its UI or backend
expects) — a fresh chat, or a different conversation, is never blocked by it.
`withLaunchLock` (Chrome-process spawn only) is unchanged from pass 1.

- [x] `createDedicatedWindowTarget` / `closeWindowTarget` — open/close a
      fresh, isolated window per request (`chrome.ts`)
- [x] `withConversationLock` / `conversationLockKey` — per-conversation lock,
      not per-profile (`chrome.ts`)
- [x] `withLaunchLock` — the launch-time race, unchanged (per profile,
      `.launch.lock`)
- [x] `backend.ts` — `run()`/`runOnce` restructured: lock only when
      continuing a conversation, dedicated window either way, window closed
      in `finally` regardless of outcome
- [x] `chrome.test.ts` — 9 tests: launch-lock serialization/propagation/
      release-on-throw/stale-recovery, conversation-lock serialization
      *within* one conversation, no serialization *across* conversations,
      the two lock kinds don't block each other, digest stability
- [x] Full suite: 697 tests pass, no regressions
- [x] Live-verified, pass 1 (serialized): 3 concurrent `oracle ask` calls,
      distinct prompts — before any fix, identical wrong answer to all three;
      after, each correct, serialized ~30s apart
- [x] Live-verified, pass 2 (parallel): same 3-way test, fresh chats — all
      three completed with their own correct, distinct answers (no timeouts,
      no cross-contamination), running concurrently rather than queued

**Known gap, not yet addressed:** `ChatGptBrowserBackend.listAccountMemories`
still uses `findOrCreatePageTarget` (the shared tab) and is not covered by
either lock. Lower priority — it's a diagnostic path, not the main `ask` flow
that was reported and reproduced — but a `run()` call and a
`listAccountMemories()` call in flight at the same time would still race, and
could now also collide with whichever window a concurrent `run()` created.

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
