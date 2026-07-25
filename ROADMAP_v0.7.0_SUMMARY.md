# v0.7.0 Advanced Features — Planning Summary

**Status:** Ready for implementation after v0.6.0 stabilizes  
**Timeline:** Q4 2026 (~3 weeks, 4 parallel workstreams)  
**Theme:** Cost tracking, Provider expansion, Sandbox hardening, Memory visualization

---

## Four Independent Features

### 1. Cost & Token Accounting (3-4 days)
**Problem:** Swarms burn tokens silently; no spending visibility  
**Solution:** `oracle usage` command + dashboard breakdown  

**Deliverables:**
- `src/runtime/costTracker.ts` — aggregation engine
- Schema v8: `cost_log` table (provider, model, tokens, agent, timestamp)
- CLI: `oracle usage today|week|month` and `--by-agent`
- Dashboard card: budget meter + trend sparkline

**Acceptance:** <100ms queries on 90-day dataset, per-agent breakdown

---

### 2. Provider Coverage Expansion (4-5 days)
**Problem:** Only Anthropic/OpenAI available; teams locked out  
**Solution:** 4 new providers + auto-detection + fallback  

**New Providers:**
- **Gemini** (Google): `gemini-2.0-flash`, `gemini-2.0-pro`
- **Ollama chat** (local): `mistral`, `llama2:7b`, `neural-chat`
- **Bedrock** (AWS): Claude models via AWS API
- **Vertex** (GCP): Unified Anthropic/Gemini via Vertex AI

**Deliverables:**
- `src/providers/gemini.ts`, `bedrock.ts`, `vertex.ts` (extend existing ollama.ts)
- Registry: model → provider auto-mapping
- Fallback: if primary provider unavailable, try next in chain
- CLI: `oracle models list` + `--model=<name>` parameter

**Acceptance:** 7 providers available, 1-line model selection

---

### 3. Sandbox Hardening (3-4 days)
**Problem:** Agent bash tool unrestricted; forks/network calls allowed  
**Solution:** OS-level isolation (Docker or Linux namespaces)  

**Approach:**
- **Docker** (recommended): Per-call container, 50ms overhead, portable
- **Namespace fallback** (Linux-only): Faster, lighter weight

**Deliverables:**
- `src/agent/sandboxDocker.ts` — Docker runtime integration
- `src/agent/sandboxNamespace.ts` — Linux unshare fallback
- Config: `sandbox.mode: "docker" | "namespace" | "none"`
- Schema v8: `sandbox_runs` table (mode, duration, resource_peak_mb)

**Acceptance:** Fork-bomb killed, network blocked, disk capped, resource limits enforced

---

### 4. Memory Graph Visualization (2-3 days)
**Problem:** Entity graph exists (521 LOC) but invisible  
**Solution:** Web UI + CLI explorer  

**Deliverables:**
- React component `MemoryGraph.tsx` using Cytoscape.js (force-directed)
- Web dashboard tab: entity browser + relationship explorer
- CLI: `oracle memory graph show|entity|path`
- API endpoint: `GET /v1/memory/graph` → JSON nodes/edges

**Features:**
- Hover: entity details + related memories
- Search: find path between two entities
- Drill-in: entity → linked memory entries
- Stats: node count, edge count, clustering coefficient

**Acceptance:** <500ms load, smooth interactions, accurate linking

---

## Effort & Schedule

| Feature | Days | Parallelizable |
|---------|------|---|
| Cost tracking | 3-4 | Yes |
| Provider expansion | 4-5 | Yes |
| Sandbox hardening | 3-4 | Yes |
| Graph visualization | 2-3 | Yes |
| **Total** | **12-16** | ✓ All parallel |

**Delivery: ~3 weeks** if all 4 started simultaneously post-v0.6.0

---

## Files to Create

```
src/runtime/costTracker.ts               # Cost aggregation & alerts
src/runtime/database.ts                  # Schema v8: cost_log, sandbox_runs
src/cli/commands/usage.ts                # oracle usage command
src/cli/commands/models.ts               # oracle models command
src/cli/commands/memory-graph.ts         # oracle memory graph command

src/providers/gemini.ts                  # New: Google Gemini
src/providers/bedrock.ts                 # New: AWS Bedrock
src/providers/vertex.ts                  # New: GCP Vertex
src/providers/index.ts                   # Update: registry, fallback

src/agent/sandboxDocker.ts               # New: Docker isolation
src/agent/sandboxNamespace.ts            # New: Linux namespace fallback
src/agent/index.ts                       # Update: sandbox config

src/web/components/MemoryGraph.tsx       # New: Graph visualization
src/web/MemoryGraphAPI.ts                # New: /v1/memory/graph endpoints
src/web/components/MemoryGraphCard.tsx   # New: Dashboard card

docs/config-schema.md                    # Update: provider section
.oracle/config.json                      # Schema update: providers, sandbox
```

---

## Quick Start (Post-v0.6.0)

### Phase 1: Cost Tracking (Days 1-4)
```bash
oracle usage today
# Output: 85,420 tokens ($1.24) | top agent: orchestrator-main ($0.62)
```

### Phase 2: Providers (Days 5-9)
```bash
oracle models list
# Output: Anthropic, OpenAI, Gemini, Ollama, Bedrock, Vertex

oracle ask "summarize this" --model=gemini-2.0-flash
```

### Phase 3: Sandbox (Days 10-13)
```bash
# Automatic in Docker deployment; namespace fallback for single-host
# Prevents fork-bomb, network exfil, disk fill
```

### Phase 4: Visualization (Days 14-17)
```bash
oracle memory graph show
# Outputs: 42 entities, 128 edges, 5 clusters

# Web UI: click Memory Graph tab → explore interactively
```

---

## Definition of Done

✅ Cost tracking: `oracle usage` shows totals, per-agent, per-provider  
✅ Provider coverage: 7 providers auto-detected + model selection works  
✅ Sandbox: Docker container runs on calls, fork-bomb killed, network blocked  
✅ Graph viz: <500ms load, entity search <100ms, path finding <100ms  
✅ Tests: integration tests for each feature, no regressions  
✅ Docs: config schema updated, CLI help text, web component doc strings  
✅ CI: All tests pass on Node 24, Docker available in runners  

---

## Blockers / Dependencies

- **Docker in CI:** GitHub Actions must have Docker available (standard on ubuntu-latest)
- **D3/Cytoscape:** Add to package.json (already used in other parts of dashboard?)
- **GCP/AWS SDK:** Conditional imports; only load if keys present (don't bloat bundle)
- **Provider API keys:** Test with mock/stub providers if CI doesn't have keys

---

## Out of Scope (v0.8+)

- Distributed cost aggregation (swarms across machines)
- Auto-provider fallback on errors (needs retry + circuit breaker)
- ML cost optimizer (auto-pick cheapest model)
- Real-time graph updates (WebSocket push)
- Memory graph learning (auto-extract entities from text)

---

## Success Metrics

**Cost Tracking:**
- Query latency: <100ms for 90-day dataset with 1000+ entries
- Accuracy: zero dropped calls, per-agent totals match sum check

**Provider Coverage:**
- 7 providers available, fallback chain works (1 provider down = next auto-tried)
- Latency: <10ms to list available models

**Sandbox:**
- Fork-bomb killed within 100 processes (cgroup enforced)
- Network call blocked (iptables/network namespace enforced)
- Disk fill capped (tmpfs size limit enforced)

**Graph Visualization:**
- 500+ entity graphs render <500ms
- Entity search: <100ms per query
- Path finding: <100ms for depth=5 graphs

---

This roadmap is ready for team review. Start when v0.6.0 stabilizes (post-QA, post-release).
