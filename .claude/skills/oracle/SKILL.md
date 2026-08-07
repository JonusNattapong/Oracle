---
name: oracle
description: Use when working in this repo (Oracle CLI/MCP project) and the task involves asking an expert model about code, running the autonomous coding agent, remembering/recalling project knowledge, or managing identity/persona. Covers the oracle_* MCP tool surface registered by src/mcp/server.ts.
---

# Oracle Skill (this repo's own MCP server)

This project registers its own MCP tools under the `oracle_*` prefix (see
`src/mcp/server.ts`). It bundles four capabilities in one server:

- **Ask** — `oracle_ask`: one entry point for Q&A; pass `files` to include real
  code, omit for plain conversation. Pass an `oracle` profile to auto-scope memory.
- **Agent** — `oracle_agent`: autonomous coding loop that reads/writes/edits files
  and runs shell commands until a task is done (needs `anthropic`/`opencode`; see
  `AGENTS.md`).
- **Memory** — `.oracle-memory/` fact/insight/chunk/working entries, scoped per agent.
- **Identity** — your profile + Oracle's persona, auto-injected into every `oracle_ask`.

## 0. Setup (once per workspace)

```bash
oracle setup-mcp --client claude-code
```

This registers the built server (`oracle.js`) with Claude Code. After that,
all tools below appear natively in the session — no separate process to run.

## 1. Session-start sequence

```
1. oracle_identity_show
     → see your saved identity + Oracle's persona (skip if not set up yet)

2. oracle_skills
     → list available skills (review, debug, security, ...) before consulting

3. oracle_oracle_list
     → see registered oracle profiles (skill+model+provider+memory bundles)

4. oracle_memory_list { agent: "<your-name>", limit: 5 }
     → surface recent facts/insights before starting work, if memory is relevant
```

If identity has never been set up, call `oracle_identity_setup` once with
name/role/preferences — every `oracle_ask` call after that auto-injects
this context into the system prompt, no need to repeat it.

## 2. Ask vs Agent — pick the right entry point

```
oracle_ask { question, oracle?, files?, conversationId?, include_docs? }
   │  Read-only advice / Q&A. Does NOT change the workspace.
   ├─ pass `files` to include real code; omit for plain conversation
   ├─ pass `oracle` (profile) to auto-scope memory (recall + save insight)
   └─ pass `conversationId` to keep continuity across calls

oracle_agent { prompt, readOnly?, maxSteps? }
   │  Autonomous coding. CHANGES the workspace unless readOnly.
   ├─ reads/writes/edits files, greps, runs shell commands in a tool loop
   ├─ readOnly=true → investigate only (no write/edit/bash)
   └─ needs an agent-capable provider (anthropic or opencode)
```

Use `oracle_ask` for "what/why/how" questions and reviews; use `oracle_agent`
for "implement/fix/refactor" tasks where files should actually change.

## 3. Full flow

```
SESSION START
  ├─► oracle_identity_show                         (context about you)
  ├─► oracle_memory_list(agent=me, limit=5)         (recent knowledge)

WORK
  ├─► oracle_ask(question, files?, oracle?)          (advice; auto: identity + memory)
  ├─► oracle_agent(prompt)                           (make the change; readOnly to inspect)
  └─► oracle_sessions / oracle_session_get           (recall past work)

MAINTENANCE (occasional, not every turn)
  ├─► oracle_memory_clear(agent=me)                 (before a fresh task)
  └─► oracle_oracle_register(name, skill, memory)   (save a reusable preset)
```

## 4. Reference — key tools

| Category | Tools |
|---|---|
| Ask / Agent | `oracle_ask`, `oracle_agent` |
| Sessions / skills | `oracle_skills`, `oracle_sessions`, `oracle_session_get` |
| Oracle profiles | `oracle_oracle_list`, `oracle_oracle_register` |
| Memory | `oracle_memory_list`, `oracle_memory_search`, `oracle_memory_clear` |
| Identity | `oracle_identity_show`, `oracle_identity_setup`, `oracle_persona_set` |
| Diagnostics | `oracle_doctor` |

On-disk store: `.oracle-memory/{facts,insights,chunks,working}/`, scoped to the workspace root the MCP server was started against (`ORACLE_WORKSPACE_ROOT` or `cwd`).

## Red flags — you're breaking the flow

| Thought | Reality |
|---|---|
| "I'll skip oracle_identity_show, I remember the user" | Your context resets between sessions; the profile store doesn't |
| "I'll call oracle_memory_clear after every task" | Wipes working memory needed later in the same task — only clear at real checkpoints |
| "I'll use oracle_agent to answer a question" | Use oracle_ask for read-only Q&A; oracle_agent changes files unless readOnly |
