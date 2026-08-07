# Oracle Roadmap: v0.8.0

**Status:** proposed
**Date:** 2026-08-07
**Theme:** Verifiable memory, and a core small enough to reason about

## Overview

v0.7.0 added breadth — cost tracking, four more providers, sandbox hardening,
memory visualization. v0.8.0 adds no new surface. It does two things:

1. **Workstream A — Verifiable memory.** Make Oracle's memory something a user
   can trust and check, not something they hope is right. This is the only
   capability Oracle has that competing tools structurally cannot copy.
2. **Workstream B — A core that holds its shape.** The MCP consult pipeline
   refactor landed and proved the approach. The remaining structural
   debt is the tool surface itself and the absence of any automated style gate.

The two workstreams are independent and can land in either order.

---

# Workstream A — Verifiable memory

## A1. Wire the eval harness into the release gate

### Current state

`src/memory/evalHarness.ts` implements recall@1/5/10 and MRR against a JSON
dataset. `tests/memory/eval.dataset.json` exists.

The harness is now exercised by `src/memory/evalHarness.test.ts` and the
dataset is part of `npm run verify` through the `test:eval` script. The first
gate uses a deterministic retrieval fixture so it never depends on Ollama,
network APIs, or the signed-in browser session.

### Problem

Retrieval quality is the product. `src/memory/hybridRetrieval.ts` fuses BM25 and
vector search with RRF; `src/memory/decay.ts`, `consolidation.ts`, and
`reflect.ts` all mutate what recall returns. Any of them can degrade recall to
near-zero while all 665 unit tests stay green, because no test asserts on
retrieval *quality* — only on retrieval *mechanics*.

The harness was written to catch exactly this and was then left unplugged.

### Solution

- `src/memory/evalHarness.test.ts` loads the dataset, runs the real
  `HybridRetrieval` implementation, and asserts each metric against a floor.
- `src/memory/eval.thresholds.json` records the measured deterministic floor.
- `package.json` exposes `test:eval` and runs it from `verify`.
- Extend the dataset to cover what the harness currently cannot see:
  temporal queries (`asOf`), contradiction/quarantine cases from
  `src/memory/` conflict handling, and graph-expansion recall.

### Acceptance

- [x] `npm run verify` fails if recall@5 or MRR drops below the committed floor.
- [x] A deliberate regression (lexical-only retrieval with vector fusion
      disabled) falls below the floor — covered by a regression test.
- [x] Dataset covers at least: plain recall, temporal, contradiction, graph hop.
- [x] Thresholds file records the measurement date and baseline commit.

---

## A2. Git-anchored memory

### Current state

Memory entries carry `confidence`, `sourceTrust`, tags, importance, and
bi-temporal validity. What they do not carry is any link to the code they
describe.

### Problem

A memory that says "auth is handled in `src/auth/session.ts` via the OAuth
refresh path" stays at full confidence forever — including after that file is
deleted. The store has no way to know. Contradiction detection only fires when a
*new, conflicting memory* arrives; nothing fires when reality drifts silently.

This is the dominant failure mode of every long-lived agent memory: it does not
become wrong loudly, it becomes wrong quietly.

### Solution

Add an optional `anchors` field to a memory entry:

```ts
interface MemoryAnchor {
  path: string;          // workspace-relative
  commit: string;        // sha at write time
  blobSha?: string;      // git blob hash of the file at write time
  lines?: [number, number];
}
```

- `src/memory/anchors.ts` (new) — `captureAnchors()` captures the anchor at
  write time; `checkAnchors()` compares stored `blobSha` against the working
  tree and reports `fresh | drifted | missing | unavailable`.
- `src/memory/adapter.ts` — `remember()` accepts `anchors`; recall attaches the
  current freshness to each returned entry.
- Recall ranking down-weights `drifted`, excludes `missing` by default (the
  file is gone; the memory is about nothing).
- `oracle memory verify --anchors` — sweeps the store and reports freshness
  counts. MCP exposes the same operation as `oracle_memory_maintain` with
  `action: "verify_anchors"`.
- The agent loop already audits every `write_file` / `edit_file`
  (`src/agent/audit.ts`) — feed those paths into an incremental drift check so
  the common case costs nothing extra.

### Acceptance

- [x] Writing a memory with a file reference records commit + blob sha.
- [x] Editing that file flips the entry to `drifted` on the next recall.
- [x] Deleting that file excludes the entry from recall by default.
- [x] Anchors are optional — memories with no anchor behave exactly as today,
      covered by the existing memory tests passing unmodified.
- [x] Drift check on a 1000-entry store completes in under 500 ms using the
      append-only anchor index plus parallel file hashing.

---

## A3. Citations, and `oracle memory why`

### Current state

`oracle ask` and `oracle_ask` recall project memory and inject it as a labelled
prompt block. The user sees the answer. They do not see what it was built from.

### Problem

Grounded and hallucinated answers look identical from the outside. A memory
system whose contribution is invisible cannot be trusted or debugged — and when
it *is* wrong, the user has no thread to pull.

### Solution

- Tag each recalled entry with a short reference (`[m1]`, `[m2]`, `[d1]` for
  docs) in the prompt block, and instruct the model to cite them inline.
- Return the reference table in `structuredContent` (MCP) and print it under the
  answer (CLI). Include each entry's anchor freshness from A2 — a citation to a
  drifted memory should say so.
- `oracle memory why <entryId> --for "<question>"` — runs the graph `findPath`
  that already exists and prints why the entry was reachable from the question.
- `--no-citations` for callers that want the bare answer.

### Acceptance

- [x] An answer using recalled memory lists the entries it used.
- [x] An answer using none says so explicitly instead of listing nothing.
- [x] Citation ids in the text resolve to real entry ids — validated, and a
      model citing a nonexistent id is reported rather than passed through.
- [x] `oracle memory why` prints a path for a reachable entry and a clear
      "not reachable" for one pulled in by lexical match alone.

---

# Workstream B — A core that holds its shape

## B1. MCP tool surface budget

### Current state

`src/mcp/tools/` exposes roughly 36 `oracle_*` tools, 11 of which are
`oracle_github_*`. Every one of their JSON schemas is loaded into the host's
context at session start, for every session, whether or not the user touches
GitHub.

`oracle_run` (commit `0983754`) already classifies consultation, research,
planning, and action requests behind a single entry point — the consolidation
mechanism exists and is unused for this purpose.

### Problem

The tool surface is a fixed tax on every conversation in every MCP host. It has
never been measured, so nobody knows the size of the tax.

### Solution

1. **Measure first.** `scripts/tool-budget.mjs` — serializes the registered tool
   schemas and reports total tokens, and the cost per tool. Publish the number.
   If it is small, stop here and close this item honestly.
2. If it is not small, split the surface into a **core tier** (ask, agent,
   memory, run, doctor — the tools used in most sessions) and **on-demand
   tiers** (github, docs, history, sessions, oracles) reachable through
   `oracle_run` or an explicit opt-in in `.oracle/config.json`.
3. Default to the core tier; document how to enable the rest.

### Acceptance

- [x] The token cost of the full tool surface is measured and recorded in
      `docs/MCP-STANDARDS.md`.
- [x] The tiering decision cites that measurement; 20 tools / ~3,880 tokens is
      small enough to keep the current surface.
- [x] Tiering did not ship because the measured surface is small; the existing
      tool-list integration test continues to assert the advertised surface.

---

## B2. A style gate

### Current state

`AGENTS.md` states it plainly: "No linter/formatter is configured — rely on `tsc`
and consistent style." That is 31 modules and ~70 test files held together by
discipline.

### Solution

Add **oxlint** (Rust, no config needed to start, runs in well under a second on
this tree). Not ESLint — the config burden is not worth it here.

- `npm run lint` added to `verify`.
- Start with the recommended ruleset only. Fix what it finds or silence it
  explicitly; do not land a gate that is already yellow.
- Formatting is out of scope for this item. A formatter rewrites every file and
  would bury the next month of diffs. Revisit separately.

### Acceptance

- [x] `npm run lint` exits clean on `main`.
- [x] `verify` runs the lint gate before tests and fails on a newly introduced lint error.
- [x] No behavioral change: the full test suite passes unmodified.

---

## B3. Close out the lifecycle plan

The MCP consult lifecycle refactor is shipped: `src/mcp/response.ts` holds the
single `failure()`, `src/mcp/pipeline/` holds the pipeline, stages, and shared
schema, and the `maxInputBytes` drift bug has a named regression test at
`src/mcp/pipeline/consultPipeline.test.ts`. The former root-level plan was
completed and removed so it cannot be mistaken for pending work.

- [x] Close out and remove the completed lifecycle plan.

---

# Out of scope

- **Backend strategy.** Whether `chatgpt-browser` stays the default and whether
  the router gains failover is a separate decision with its own blast radius.
  It is deliberately not bundled here.
- **New providers, new surfaces, new tools.** v0.8.0 adds no capability the
  README does not already claim.

# Sequencing

A1 first — it is the cheapest item here and it protects everything else in
Workstream A. B2 can land any time and is independent. A2 is the largest single
piece; A3 depends on it only for the freshness annotation and can start in
parallel.
