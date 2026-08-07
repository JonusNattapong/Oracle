# PLAN — MCP Consult Lifecycle Refactor

**Status:** proposed
**Date:** 2026-08-06
**Scope:** `src/mcp/` only. CLI (`src/cli.ts`) and `src/core/consult.ts` are untouched.

---

## 1. Problem

`oracle_relay` (`src/mcp/tools/relay.ts`, 235 lines) was built by copying
`oracle_ask` (`src/mcp/tools/consult.ts`, 208 lines). The two tools now share
roughly 90% of their body verbatim.

### Duplicated between `consult.ts` and `relay.ts`

| Concern | `consult.ts` | `relay.ts` |
| --- | --- | --- |
| `success()` / `failure()` helpers | L17–43 | L20–47 — byte-identical |
| soul → awareness → `buildOracleSystemPrompt` | L88–101 | L163–176 |
| conversation → memory → docs → context block | L102–140 | L121–148 |
| files + `git_diff` + `git_staged` + `ast_resolve` + dedupe | L142–155 | L150–160 |
| `service.consult()` + status check | L159–178 | L182–198 |
| `recordSelfLog` for `conversationId` | L180–182 | L208–214 |

### Drift this has already caused

`relay.ts` (L182–194) omits `maxFileSizeBytes` and `maxInputBytes` when calling
`service.consult()`. `consult.ts` (L172–173) passes both. **Result:
`oracle_relay` silently ignores the project's configured context limits.** This
is a live bug, and it is exactly the failure mode duplicated code produces —
one copy was fixed, the other was not.

### Wider duplication

`failure()` is copy-pasted into **13 files** under `src/mcp/tools/`:
`agent.ts`, `consult.ts`, `docs.ts`, `github.ts`, `history.ts`, `identity.ts`,
`memory.ts`, `oracle.ts`, `relay.ts`, `session.ts`, `util.ts`, `web.ts`.

---

## 2. Design — pipeline plus lifecycle hooks

Separate the **sequence** (identical for every consult-shaped tool) from the
**policy** (what makes each tool different).

```
                 ┌──────────── ConsultPipeline (single source) ─────────┐
                 │                                                       │
  request ──────►│  1. resolve   soul → awareness → systemPrompt         │
                 │  2. gather    conversation → memory → docs            │
                 │  3. collect   files → git → ast → dedupe              │
                 │  4. execute   service.consult()                       │
                 │  5. persist   recordSelfLog                           │
                 │  6. present   success() / failure()                   │
                 └───────────────────────────────────────────────────────┘
                        ▲                                ▲
                 onBeforeExecute                   onAfterExecute
                        │                                │
        relay: archive request as         relay: file the Q&A into the
               working memory                    memory bank
        ask:   no-op                       ask:   no-op
```

Stage 4 is the only place `service.consult()` is called, so config limits are
passed exactly once and cannot drift again.

---

## 3. Target file layout

```
src/mcp/
  response.ts                  NEW  — shared success() / failure()
  pipeline/
    consultPipeline.ts         NEW  — stages 1–5 + hook dispatch
    stages.ts                  NEW  — resolveIdentity / gatherContext / collectFiles
    schema.ts                  NEW  — shared zod fields (files, git_diff, soul, …)
  tools/
    consult.ts                 SHRINK ~208 → ~60 lines (schema + pipeline call)
    relay.ts                   SHRINK ~235 → ~70 lines (schema + two hooks)
    <11 other tools>           EDIT — import failure() from ../response.js
```

---

## 4. Interfaces

```ts
// src/mcp/pipeline/consultPipeline.ts

export interface PipelineContext {
  prompt: string;
  soulName: string;
  systemPrompt: string;
  contextBlock: string;
  files: string[];
  astFiles: string[];
  conversationId?: string;
  /** Scratch space for hooks to pass values between before/after. */
  state: Record<string, unknown>;
}

export interface ConsultHooks {
  onBeforeExecute?(ctx: PipelineContext): Promise<void>;
  onAfterExecute?(
    ctx: PipelineContext,
    result: ConsultResult
  ): Promise<Record<string, unknown>>;
}

export async function runConsultPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
  hooks?: ConsultHooks
): Promise<PipelineOutcome>;
```

`onAfterExecute` returns a record that is merged into the tool's
`structuredContent`, so `oracle_relay` can keep reporting its `memory` block
without the pipeline knowing anything about memory archiving.

### `relay.ts` after the refactor

```ts
const outcome = await runConsultPipeline(input, deps, {
  async onBeforeExecute(ctx) {
    ctx.state.requestEntry = await deps.memory.remember(agent, "working", prompt, {
      tags: [...allTags, "request"],
      importance: 0.7
    });
  },
  async onAfterExecute(ctx, result) {
    const stored = await deps.memory.remember(
      agent,
      store_as as MemoryType,
      `**Q:** ${prompt}\n\n**A:** ${result.output}`,
      {
        tags: allTags,
        importance: store_as === "fact" ? 0.9 : 0.8,
        meta: { source: "relay", sessionId: result.sessionId, responseId: result.responseId }
      }
    );
    return {
      memory: {
        workingEntryId: (ctx.state.requestEntry as MemoryEntry).id,
        storedEntryId: stored.id,
        storedType: store_as,
        storedTags: allTags
      }
    };
  }
});
```

---

## 5. Tool-specific inputs the pipeline must still support

These are the fields that genuinely differ; the pipeline accepts them as
optional input rather than being forked per tool.

| Field | `oracle_ask` | `oracle_relay` |
| --- | --- | --- |
| `context` (free-text from caller) | yes | no |
| `active_file` + `cursor_position` | yes | no |
| `backend` override | yes | no |
| `accountMemory` | yes | no |
| `compress_context` | yes | no |
| `agent` attribution | no | yes |
| `store_as` / `tags` / `recall` | no | yes |
| `preset` passed to `ConsultService` | `"review"` | `"relay"` |

`preset` is metadata only — it lands on the session record
(`src/core/consult.ts:165`) and is not validated against `PRESET_NAMES`, so
`"relay"` is legal. Preserve both values as-is.

---

## 6. Execution steps

1. **`src/mcp/response.ts`** — extract `success()` / `failure()`. Update all 13
   tool files to import them. Pure move, no behavior change.
2. **`src/mcp/pipeline/stages.ts`** — lift `resolveIdentity`, `gatherContext`,
   `collectFiles` out of `consult.ts` verbatim.
3. **`src/mcp/pipeline/consultPipeline.ts`** — assemble stages, add hook
   dispatch, always pass `maxFileSizeBytes` / `maxInputBytes`.
4. **Rewrite `tools/consult.ts`** on the pipeline. Run tests — must stay green
   with zero test edits.
5. **Rewrite `tools/relay.ts`** on the pipeline with the two hooks. The
   `maxInputBytes` bug is fixed as a side effect of step 3.
6. **`src/mcp/pipeline/schema.ts`** — factor the shared zod field definitions
   once both tools are on the pipeline and the real overlap is visible.
7. `npm run typecheck && npm test`.

Steps 1–3 are additive and can land independently of 4–6.

---

## 7. Out of scope

- **`oracle_agent`** — an autonomous loop, not a one-shot consult. It does not
  fit this lifecycle and must not be forced into it.
- **CLI** — `src/cli.ts` keeps calling `ConsultService` directly. Sharing the
  pipeline with the CLI would mean moving it to `src/core/`; that is a separate
  change with a different blast radius. Revisit only after this lands.
- **Tool surface** — no tools added or removed. The 44-tool MCP surface
  documented in `src/mcp/server.ts` stays exactly as it is.

---

## 8. Acceptance criteria

- [ ] `npm run typecheck` clean.
- [ ] All 654 existing tests pass **without modification** — this is the proof
      that behavior is unchanged.
- [ ] `service.consult()` is called from exactly one location in `src/mcp/`.
- [ ] `success()` / `failure()` are defined exactly once in `src/mcp/`.
- [ ] `oracle_relay` honours `maxFileSizeBytes` and `maxInputBytes`, covered by
      a new regression test.
- [ ] Combined line count of `src/mcp/tools/` drops (est. ~1,615 → ~1,100),
      with the difference relocated into `pipeline/` + `response.ts`, not
      deleted.
