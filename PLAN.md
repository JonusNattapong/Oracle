# Oracle Server Mode — Multi-User Architecture

**Status:** Planning  
**Date:** 2026-08-07  
**Target:** v0.9.0

## Overview

Oracle is currently single-user per machine (CLI + MCP in-process). Three concurrent users on the same machine create race conditions on Chrome profile, memory store, and sessions. This plan transitions Oracle to a server architecture: one daemon serves multiple CLI/MCP clients via HTTP.

## Problem Statement

### Current (Single-User)

```
┌─ CLI
├─ MCP host (Claude AI)
├─ IDE extension
└─ Other clients
  ↓ (all in-process)
[Chrome profile (locked)]
[Memory files (~/.oracle/memory/*.jsonl)]
[Sessions dir (~/.oracle/sessions/...)]
```

**Issues:**
1. Two Chrome instances race over the same profile → `DevToolsActivePort` collision → CDP hangs (fixed in 7b2bb96, but symptom of deeper issue)
2. Memory store is file-based → concurrent writes corrupt JSONL
3. Sessions write directly to disk → filename collisions
4. Cannot share memory/context across users
5. Three concurrent users = three Chrome instances = massive resource use

### Target (Multi-User)

```
┌─ CLI (HTTP client)
├─ MCP host (HTTP client)
├─ IDE extension (HTTP client)
└─ Other clients
  ↓ (all HTTP/REST)
[Oracle Server (daemon)]
├─ PostgreSQL (shared memory + audit)
├─ Chrome instance (shared, queued)
└─ Session manager
```

**Benefits:**
1. One Chrome instance, many CLI clients (resource-efficient)
2. Shared memory across users (context accumulates)
3. Persistent audit trail (who did what, when)
4. Safe concurrent access (ACID guarantees)
5. Scales to N users on same machine

---

## Architecture Decisions

### Database: PostgreSQL

**Decision:** SQLite → PostgreSQL  
**Reasoning:** [SQLite vs PostgreSQL](https://betterstack.com/community/guides/databases/postgresql-vs-sqlite/) — SQLite uses file locking, unsuitable for concurrent writers. PostgreSQL is the default for multi-user server daemons.

**Schema sketch:**
```sql
CREATE TABLE memory_entries (
  id UUID PRIMARY KEY,
  content TEXT,
  anchors JSONB,  -- A2: git-anchored memory
  created_at TIMESTAMPTZ,
  drifted_at TIMESTAMPTZ,  -- when blob SHA diverged
  ...
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  user_id TEXT,
  action TEXT,  -- oracle_ask, oracle_agent_start, ...
  request JSONB,
  response JSONB,
  duration_ms INT,
  created_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id TEXT,
  conversation_id TEXT,
  messages JSONB[],
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

### Authentication: Token File + Bearer Token

**Decision:** API key → Token file (access + refresh)  
**Reasoning:** [WorkOS CLI auth guide](https://workos.com/guide/best-practices-cli-authentication-a-technical-guide) — Static API keys unsuitable for team environments. Token file with refresh pattern is industry-standard (GitHub CLI, gcloud, etc.).

**Flow:**
```bash
# First time: redirect to login
$ oracle login
# Opens browser → CLI confirms → server mints tokens
# Stores in ~/.oracle/auth/tokens.json (mode 0600)

# Subsequent runs: auto-refresh
$ oracle ask "..."
# CLI reads access token from disk → HTTP Bearer header
# Server validates → identifies user → audit log
# If expired → CLI uses refresh token → get new access token
```

**Security:**
- Token file permission 0600 (user-only read/write)
- Access token short-lived (15 min)
- Refresh token long-lived (30 days)
- Rotate on logout

### API: REST + Bearer Token

**Decision:** gRPC → REST with standard Bearer tokens  
**Reasoning:** Simpler for CLI clients, standard HTTP debugging, no protobuf codegen, easier to mock in tests.

**Endpoints sketch:**
```
POST /api/v1/ask
  headers: Authorization: Bearer <token>
  body: { prompt, model, tool, ... }
  response: { id, messages[], citations[], ... }

POST /api/v1/agent/start
  ...

GET /api/v1/sessions/<id>
  ...

GET /health
  response: { status, db_ok, chrome_ok }
```

---

## Implementation Phases

### Phase 1: Server + Auth + DB (Sprint 1 — 3–4 days)

**Goal:** Minimal server that serves multiple CLI clients safely.

#### 1.1 PostgreSQL & schema
- [ ] `src/database/schema.sql` — tables: memory_entries, audit_log, sessions
- [ ] `src/database/migrate.ts` — migration runner
- [ ] Create local Postgres + init script (development only)
- [ ] Write to PLAN.md: "Ops: dev requires `postgres` on PATH; production uses `DATABASE_URL` env var"

#### 1.2 HTTP server
- [ ] `src/server/server.ts` — Express/Fastify with Router
- [ ] `src/server/routes.ts` — `/api/v1/ask`, `/api/v1/agent/...`, `/health`
- [ ] `src/server/middleware/auth.ts` — Bearer token validation
- [ ] `src/server/middleware/audit.ts` — log every request to audit_log table
- [ ] Graceful shutdown (SIGTERM → drain in-flight, close DB)

#### 1.3 Authentication
- [ ] `src/auth/tokens.ts` — JWT generation (access + refresh)
- [ ] `src/auth/flow.ts` — OAuth device flow (open browser, poll server)
- [ ] `src/cli/commands/login.ts` — `oracle login` command
- [ ] `src/cli/auth-client.ts` — load token from file, refresh if needed, add to HTTP headers
- [ ] Unit tests for token lifecycle

#### 1.4 CLI → HTTP bridge
- [ ] `src/cli/http-client.ts` — HTTP request wrapper (retry, error handling)
- [ ] Replace direct service calls with `httpClient.ask(...)`
- [ ] `oracle ask --server localhost:8080` flag (dev; default reads from config)
- [ ] Update `.oracle/config.json` schema: `server: { host, port }`

#### 1.5 MCP → HTTP bridge
- [ ] `src/mcp/http-client.ts` — similar to CLI client
- [ ] MCP tools use `httpClient` instead of in-process functions
- [ ] `oracle_ask`, `oracle_agent`, etc. become HTTP calls

#### 1.6 In-memory rate limiting
- [ ] `src/server/rate-limit.ts` — token bucket per user (5 concurrent consults)
- [ ] Reject 429 if user at limit; clients retry with backoff
- [ ] Audit log: rate limit events

#### 1.7 Tests & fixtures
- [ ] `src/server/server.test.ts` — HTTP endpoints
- [ ] `src/auth/tokens.test.ts` — JWT generation/validation
- [ ] `src/cli/http-client.test.ts` — retry/error handling
- [ ] Integration test: CLI → HTTP server → in-memory store (no Postgres needed)

#### Success Criteria (Phase 1)
- ✅ `npm run test` passes (all tests, including integration)
- ✅ `oracle login` mints token file
- ✅ `oracle ask` reads token, makes HTTP request to server
- ✅ MCP host makes HTTP request to server
- ✅ `/health` endpoint reports db_ok + chrome_ok
- ✅ Audit log has entries for each oracle_ask call

---

### Phase 2: Deploy & Ops (Sprint 2 — 2 days)

**Goal:** Production-ready systemd service, health checks, graceful lifecycle.

#### 2.1 Systemd service
- [ ] `oracle.service` template — `ExecStart`, `Restart`, `StandardOutput`
- [ ] `oracle install-service` command — creates service + enables
- [ ] `oracle uninstall-service` — disables + removes
- [ ] Unit tests: parse service file, verify key fields

#### 2.2 Health checks
- [ ] `GET /health` — check DB connection, Chrome responsiveness
- [ ] `oracle health` command — calls `/health`, pretty-prints
- [ ] Systemd `ExecStartPost` — optional health probe after start

#### 2.3 Logging
- [ ] Server logs to stdout (structured JSON for parsing)
- [ ] Systemd journal captures logs (`journalctl -u oracle`)
- [ ] CLI logs to `.oracle/cli.log` (timestamp, level)

#### 2.4 Graceful shutdown
- [ ] Server catches SIGTERM → drain 30 sec
- [ ] In-flight requests get 30 sec to finish
- [ ] Systemd `TimeoutStopSec=60` (gives server 30 + margin)

#### 2.5 Documentation
- [ ] README: "Run oracle server" (systemd vs manual)
- [ ] Architecture doc: how auth, DB, HTTP interact

#### Success Criteria (Phase 2)
- ✅ `oracle install-service` creates working systemd unit
- ✅ `systemctl start oracle` starts server
- ✅ `oracle health` shows db_ok + chrome_ok
- ✅ `systemctl stop oracle` gracefully shuts down
- ✅ Logs appear in `journalctl`

---

### Phase 3: Memory → DB (Sprint 3 — 3–4 days)

**Deferred.** Depends on v0.9.0 completing phases 1–2.

- [ ] Migrate `src/memory/adapter.ts` from file-based to PostgreSQL
- [ ] Add A2 (git-anchored memory): `anchors` column + drift detection
- [ ] Add A3 (citations): return `citations[]` from `oracle_ask`
- [ ] Backfill existing memory entries to DB
- [ ] Remove `~/.oracle/memory/` directory (legacy)

---

## Dependencies & Risks

### Dependencies
- **PostgreSQL** (dev: local; prod: `DATABASE_URL`)
- **jwt library** (e.g., jsonwebtoken for Node.js)
- **HTTP framework** (Express or Fastify)
- **Migration tool** (e.g., Knex, Migrate-js)

### Risks

| Risk | Mitigation |
|---|---|
| Database migration fails | Test in Docker; rollback plan per migration |
| Token theft (disk) | File permissions 0600; document SSH hardening for remote |
| Bearer token interception | Use HTTPS in production (Caddy reverse proxy) |
| Slow DB queries block CLI | Add indexes on (user_id, created_at); query timeouts |
| Chrome still bottleneck | Queue requests; document concurrency limit |
| Breaking change for MCP hosts | Bump to v0.9.0; document migration path (MCP → HTTP) |

---

## Breaking Changes

**v0.8.0 → v0.9.0:**

1. **MCP is now HTTP client** — Old code calling Oracle functions in-process breaks. MCP hosts must point to `ORACLE_SERVER_URL` env var.
   - Mitigation: Default to `localhost:8080` in dev; document in README
   - Impact: Claude AI, IDE extensions need configuration update

2. **Memory store changes** — File-based → PostgreSQL. Old `.oracle/memory/*.jsonl` files ignored.
   - Mitigation: One-time migration script (reads old files, imports to DB)
   - Impact: Users running v0.8.0 + v0.9.0 in parallel: old binary uses DB, new binary uses DB (OK)

3. **Config schema** — New `server:` section in `.oracle/config.json`
   - Mitigation: Auto-migrate old config on first run
   - Impact: None if migration succeeds

---

## Success Criteria (Overall)

- ✅ 3 concurrent users on same machine
- ✅ No Chrome profile collisions
- ✅ Memory shared across users
- ✅ Audit trail complete + queryable
- ✅ All tests pass
- ✅ systemd service works
- ✅ Backward compat migration path documented

---

## Timeline

| Phase | Days | Start | End |
|---|---|---|---|
| **1: Server + Auth + DB** | 3–4 | 2026-08-08 | 2026-08-12 |
| **2: Deploy + Ops** | 2 | 2026-08-13 | 2026-08-15 |
| **3: Memory → DB** | 3–4 | 2026-08-20 | 2026-08-24 |

---

## Related Roadmap

- **A1:** Eval harness (memory quality) — independent, can proceed in parallel
- **A2:** Git-anchored memory — part of Phase 3
- **A3:** Citations — part of Phase 3
- **B1:** Tool budget — independent
- **B2:** Style gate — independent

---

## Questions for Review

1. **Database location:** Assume local Postgres for dev; do we provide Docker Compose or expect user to `brew install postgresql`?
2. **Token expiry:** 15 min access / 30 day refresh — OK or too short/long?
3. **Rate limit:** 5 concurrent per user — OK for 3 users or too strict?
4. **Production deployment:** systemd assumes Linux; Windows/macOS users need different (scheduled task / launchd)?
5. **HTTPS:** Reverse proxy (Caddy) in front of server, or assume localhost-only dev use?
