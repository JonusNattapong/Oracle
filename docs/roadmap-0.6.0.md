# Oracle Roadmap: v0.6.0

**Theme:** Memory Engine Foundation — Retire JSON, Adopt SQLite + Hybrid Retrieval

**Why:** v0.1–v0.5 completed the "multi-agent + human oversight" stack. But Memory (pillar #1 in README) is the slowest part of the codebase. Vector search is O(n) linear scan in RAM, BM25 exists but unused, embedding provider is hardcoded to Ollama with silent failures, and we have no eval to prove we actually got better. This debt compounds every release.

**Outcome:** Move memory from JSON files to SQLite (schema v7), hybrid retrieval (BM25 + vector via RRF fusion), pluggable embedding providers, and measurable recall improvements.

---

## Primary Work: Memory Engine (4 items)

### 1. Vector Search: RAM → SQLite + sqlite-vec
**Current problem:** `src/memory/vectorStore.ts:20` loads entire vectors.json into array, then `search()` runs O(n) cosine against every record per query. At 50k memories = 50k cosine ops per recall. Plus `save()` at line 43 does `void this.save()` (no await) — parallel writes from multiple agents cause lost-write races, which is *the* use case for this project.

**Fix:** Migrate to SQLite schema v7 with `embeddings BLOB` + sqlite-vec extension
- Get transaction safety, WAL concurrency, and cross-process locking for free (same deal coordination got in v0.5)
- Vector search becomes indexed lookup + nearest-neighbor, O(log n) + k

**Acceptance:** Exact same search results as before (same vectors), but <100ms p99 for 50k-memory query (was: >500ms sometimes)

---

### 2. Hybrid Retrieval: BM25 + Vector Fusion
**Current problem:** `src/docs/bm25.ts` exists but memory doesn't use it. `adapter.ts:261` implements custom lexicalScore() only. Semantic/lexical are either/or: if vector succeeds at line 252, return immediately — lexical never runs.

**Fix:** 
- Native FTS5 (SQLite built-in) for BM25 on memory content
- Rerank: BM25 scores + vector scores fused via Reciprocal Rank Fusion (RRF), then apply recencyWeightedScore() as before
- Both always run; results merge (no early return)

**Acceptance:** Hybrid queries return both keyword and semantic matches ranked together; pure-keyword topics get found even if embedder is down

---

### 3. Embedding Providers: Pluggable Interface
**Current problem:** `src/memory/ollama.ts` (38 lines) hardcodes Ollama. If the machine has no Ollama, embedding fails silently — `adapter.ts:39` does `if (!emb) return;` and falls back to keyword match without telling the user.

**Fix:**
- `EmbeddingProvider` interface: `embed(text: string): Promise<number[]>`
- Implementations: Ollama, Voyage, OpenAI, Gemini
- Config at `.oracle/config.json`: which provider + API keys
- `oracle doctor` shows "semantic: on (via Voyage)" or "semantic: off (no provider configured)" — visibility, not silence

**Acceptance:** `oracle doctor` correctly reports embedding status; switching providers is config, not code

---

### 4. Eval Harness: Prove Recall Got Better
**Current problem:** README claims "ranked by relevance" but there is no eval. Releasing v0.6.0 is just a features list — unverified.

**Fix:**
- Eval dataset: ~200 (query, relevant_memory_id, ...) pairs covering: agent tasks, debugging, cross-session recall, entity lookups
- Metrics: recall@1, recall@5, recall@10, MRR (Mean Reciprocal Rank)
- Benchmark: v0.5.0 (keyword) vs v0.6.0 (hybrid) on same dataset
- CI: run evals on every PR (target: recall@5 ≥95%, no regression >2%)

**Acceptance:** Release notes say "recall@5: 78% → 94%" (or whatever the numbers are) — concrete, not aspirational

---

## Separable: CI + TLS (ship independently)

### CI Pipeline
- Add `.github/workflows/ci.yml` running `npm run verify` on push/PR
  - Covers: build + 181 tests + smoke CLI + smoke runtime
  - Currently only runs on `npm publish` (too late)
- **Impact:** Catch breakage before merge

### TLS for Remote Swarm
- `swarmService.ts` exposes HTTP listener with no encryption (documented gap in v0.5.0 CHANGELOG)
- Add native TLS: self-signed cert at `~/.oracle/remote-cert.pem` (generated at `oracle init`)
- Add token TTL + rotation: currently token-revoke only, no expiry (`swarmService.ts` has no TTL logic)
- **Impact:** Leaked tokens have bounded lifetime; no need for reverse proxy workaround

Both are orthogonal to Memory Engine; can merge independently.

---

## Defer to v0.7.0

- **Cost & token accounting:** `providers/anthropic.ts` tracks inputTokens/outputTokens per call but no aggregate. Swarms need visibility. → `oracle usage` command + usage card in dashboard
- **Provider coverage:** Add Gemini, Bedrock, Vertex, Ollama chat (anthropic/openai/codex exist)
- **Sandbox hardening:** `resourcelimits.ts` caps timeout 30s + output 100KB only; no network/process isolation (agent has bash tool). Needs OS-level or container sandbox.
- **Memory graph UI:** `entityGraph.ts` (521 lines) has no visualization → web dashboard browser + graph explorer

---

## Context: Version Themes

| Ver | Theme | Status |
|-----|-------|--------|
| 0.1 | Coordination | ✓ Complete |
| 0.2 | Runtime (daemon + SQLite) | ✓ Complete (schema v6) |
| 0.3 | Control Center | ✓ Complete |
| 0.4 | Human Control Plane (approval + audit) | ✓ Complete |
| 0.5 | Remote Swarm (cross-machine agents) | ✓ Complete |
| **0.6** | **Memory Engine** | → Start here |

v0.1–v0.5 built the orchestration layer. v0.6 pays down the biggest technical debt and makes the #1 pillar (Remember) match the marketing.

## Separable Work: CI/TLS

These can be merged independently; no memory-engine dependency:

- **TLS for Remote Swarm:** Encrypt authenticated websocket connections (mTLS certs in `~/.oracle/remote.json`)
  - Owner: setup at `oracle init`; per-machine key pair
  - Reduces surface for token interception
  
- **CI Integration:** GitHub Actions workflow template for `oracle doctor` health checks
  - Run on every PR: verify MCP setup, memory integrity, daemon connectivity
  - Fail fast if critical components missing

Both are nice-to-haves for v0.6.0; can ship in patch releases or v0.7.0 without blocking.

## Deferred to v0.7.0

- **Distributed Orchestration:** Swarm-wide task coordination (requires Entity Graph from v0.6.0)
- **Memory Visualization:** Graph explorer UI for memory relationships (waiting on Memory Engine + entity linking)
- **Advanced Scheduling:** Workflow DAGs with memory-based decision gates
- **Audit Dashboard:** Rich UI for memory audit logs and entity graph introspection

## Migration & Breaking Changes

**None.** v0.6.0 is purely additive:
- Memory API surface unchanged (new optional parameters only)
- CLI stable; new `audit` subcommand added
- Storage format: existing entries auto-migrated on first access (backwards compatible)

## Testing & Verification

- Unit tests: 85% coverage for Memory Engine (search, consolidation, audit)
- Integration tests: multi-agent memory sharing across 3+ sessions
- Load test: 10k memory entries with search under 100ms p99
- Regression: all v0.5.0 workflows still work unmodified

## Success Metrics

- Memory queries return semantically relevant results in top 3 (was: top 5)
- Consolidation reduces memory size by 20-30% without losing information
- Entity graph latency <50ms for 100-entity queries
- Zero integrity violations after audit pass

---

**Next:** Start with Memory Engine implementation (find → ranking → entity graph → consolidation). CI/TLS can run in parallel.
