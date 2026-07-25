# Oracle Roadmap: v0.7.0

**Theme:** Advanced Features — Cost Tracking, Provider Expansion, Sandbox Hardening, Memory Visualization

Release target: Q4 2026 (after v0.6.0 stabilizes)

## Overview

v0.6.0 completed the Memory Engine foundation. v0.7.0 adds four orthogonal feature areas:

1. **Cost & Token Accounting** — Swarms waste tokens silently. Visibility via per-agent and per-call tracking.
2. **Provider Coverage** — Add Gemini, Bedrock, Vertex, Ollama chat beyond current Anthropic/OpenAI/Codex.
3. **Sandbox Hardening** — Process/network isolation for agent bash tool (currently only timeout + output cap).
4. **Memory Graph Visualization** — EntityGraph (521 lines, JSON-based) gains a web UI + graph explorer.

---

## 1. Cost & Token Accounting

### Current State
- `providers/anthropic.ts`: Tracks `inputTokens`, `outputTokens` per API call ✓
- No aggregation: nobody ever sees totals
- Swarm agents run independently → no shared cost view
- Silent assumption: "we're not wasting tokens"

### Problem
- At scale (20 agents × 100 calls/day × 1000 tokens/call), cost becomes invisible
- Swarms can't budget or alert on overspend
- No per-agent cost breakdown for accountability

### Solution: `oracle usage` command + dashboard card

**Files to add/modify:**
- `src/runtime/costTracker.ts` (new)
  - Interface: `CostTracker` tracks per-provider costs
  - Aggregation: sum across all calls (window: today/week/month)
  - Per-agent breakdown: which agent spent how much
  - Alert thresholds: warn at 80%, block at 100%
  
- `src/runtime/database.ts` (schema v8)
  - `cost_log` table: (call_id, provider, model, input_tokens, output_tokens, cost_usd, created_at, agent)
  - Index: (agent, created_at) for fast per-agent queries
  - Retention: keep 90 days (archivable)
  
- `src/cli/commands/usage.ts` (new)
  - `oracle usage today|week|month`
  - `oracle usage by-agent`
  - `oracle usage alerts`
  - Shows: total spend, avg per-call, top agents, trend
  
- Web dashboard card (existing dashboard logic)
  - "Token budget: 1.2M / 2M (60%)" with trend sparkline
  - Click to drill: per-agent costs, provider breakdown

**Acceptance:**
```bash
$ oracle usage today
Total today:  85,420 tokens ($1.24)
├─ Anthropic: 50,000 tokens ($0.75)
├─ OpenAI:    35,420 tokens ($0.49)

Top agents:
└─ orchestrator-main: 42,300 tokens ($0.62)
└─ knowledge-sync:    28,100 tokens ($0.50)
└─ audit-check:       15,020 tokens ($0.12)
```

**Metrics:** <100ms query on 90-day dataset, <1ms per-agent breakdown

---

## 2. Provider Coverage

### Current State
- Implemented: Anthropic, OpenAI, Codex
- Missing: Gemini, Bedrock, Vertex, Ollama chat models

### Problem
- Teams using non-Anthropic prefer native provider integration
- Ollama chat models (mistral, llama2) not available (only embeddings)
- Bedrock (AWS) locks teams into single cloud
- No unified interface; each provider is a one-off

### Solution: Expand ProviderAdapter pattern

**Files to add:**
- `src/providers/gemini.ts`
  - Models: `gemini-2.0-flash`, `gemini-2.0-pro`
  - SDK: `@google/generative-ai`
  - Streaming + tool use support
  
- `src/providers/ollama.ts` (extend existing)
  - Chat models: `mistral`, `llama2:7b`, `neural-chat`
  - Endpoint: `OLLAMA_ENDPOINT` (default: localhost:11434)
  - Fallback: if unreachable, warn (don't block)
  
- `src/providers/bedrock.ts`
  - Models: `claude-3-sonnet`, `claude-3-haiku` (via Bedrock)
  - Requires: AWS credentials + region
  - Use case: teams locked to AWS, want Anthropic models
  
- `src/providers/vertex.ts`
  - Models: Anthropic/Gemini via Vertex AI (GCP)
  - Auth: GOOGLE_APPLICATION_CREDENTIALS + PROJECT_ID
  - Use case: teams on GCP, want unified Anthropic access

**Files to modify:**
- `src/providers/index.ts`
  - Auto-detect available providers from env vars
  - Registry: map model → provider (e.g., "gpt-4" → openai, "claude-3" → anthropic or bedrock or vertex)
  - Fallback chain: if bedrock-claude unavailable, try native anthropic
  
- `src/mcp/tools/consult.ts`
  - Model selector: `--model=gemini-2.0-flash` or auto-pick best available
  - Show available models: `oracle models list`

**Acceptance:**
```bash
$ oracle models list
Anthropic:    claude-3-sonnet, claude-3-haiku
OpenAI:       gpt-4, gpt-4-turbo
Gemini:       gemini-2.0-flash, gemini-2.0-pro (requires GEMINI_API_KEY)
Ollama:       mistral, llama2:7b (requires http://localhost:11434)
Bedrock:      claude-3-sonnet (requires AWS_REGION + credentials)

$ oracle ask "summarize this" -m gemini-2.0-flash
```

**Config schema update:** `.oracle/config.json`
```json
{
  "providers": {
    "default": "anthropic",
    "ollama": { "endpoint": "http://localhost:11434" },
    "bedrock": { "region": "us-east-1" }
  }
}
```

---

## 3. Sandbox Hardening

### Current State
- `resourcelimits.ts`: Timeout 30s + output cap 100KB only
- No process isolation (PID namespace)
- No network isolation (still can make arbitrary HTTP calls)
- Agent has unrestricted bash tool access

### Problem
- Runaway commands can:
  - Fork-bomb the host
  - Exfiltrate data via HTTP
  - Consume all disk/memory
  - Kill sibling processes
- Jails must survive untrusted prompt injection + accidental bugs

### Solution: OS-level + container isolation

**Approach A: Docker (recommended for production)**
- Files: `src/agent/sandboxDocker.ts` (new)
  - Spawn container per call: `docker run --rm --cpus=0.5 --memory=512m --network=none ...`
  - Mount only necessary paths (read-only code, temp dir)
  - No stdout/stderr size limit (Docker handles it)
  - Timeout: SIGKILL after 30s
  - Cost: ~50-100ms container startup per call

**Approach B: Linux namespaces (for single-host)**
- Files: `src/agent/sandboxNamespace.ts` (new)
  - Use `unshare(1)` for PID, network, mount namespaces
  - cgroups: cpu limits, memory caps, process count
  - Chroot: filesystem isolation
  - Cost: faster (~10ms), but less portable

**Files to modify:**
- `src/agent/index.ts`
  - Config: `sandbox.mode: "docker" | "namespace" | "none"`
  - Fallback: if Docker unavailable, use namespace; if neither, warn in logs
  
- `src/runtime/database.ts` (schema v8+)
  - `sandbox_runs` table: (call_id, mode, duration, exit_code, error, resource_peak_mb)
  
- CLI: `oracle agent run --sandbox=docker --max-memory=512m --max-cpu=0.5 -- <command>`

**Acceptance:**
- Runaway fork bomb: killed after 10 fork attempts (cgroup limit)
- Network exfil: blocked (network=none)
- Disk fill: capped at temp volume size (default: 1GB)
- Upstream timeout: respected (30s → SIGKILL)

**Performance:** ~50-100ms Docker overhead per call (amortized on longer-running agents)

---

## 4. Memory Graph Visualization

### Current State
- `entityGraph.ts`: 521 lines, JSON-based in-memory graph
- Methods: `indexMemory()`, `expandQuery()`, `findPath()`, `pruneGraph()`
- Nodes: entities (Oracle, Redis, Docker, etc.)
- Edges: "mentions", "depends-on", "stored-in"
- No visualization

### Problem
- Graph exists but nobody can see it
- Debugging entity links requires CLI calls
- Pattern detection (cycles, isolated clusters) invisible
- Memory audit trail opaque to users

### Solution: Web UI + graph explorer

**Files to add:**
- `src/web/components/MemoryGraph.tsx` (new)
  - D3.js or Cytoscape.js force-directed layout
  - Nodes: entities (color by type: service/tech/concept)
  - Edges: relationships (label: "depends-on", "stores", "mentions")
  - Interactions:
    - Hover: show entity details + related memories
    - Click: drill into entity's memory entries
    - Search: highlight path between two entities
  - Stats: node count, edge count, centrality, isolated clusters
  
- `src/runtime/api.ts` (extend)
  - `GET /v1/memory/graph` → JSON graph representation (nodes + edges)
  - `GET /v1/memory/graph/entity/:name` → entity details + related memories
  - `GET /v1/memory/graph/path?from=X&to=Y` → shortest path
  
- `src/memory/entityGraph.ts` (add serialization)
  - `toJSON()`: serialize for web (nodes: {id, label, type}, edges: {source, target, type})
  - Pagination: return top-N by degree (most connected entities first)

**Dashboard card:**
- "Entity Graph" tab showing:
  - Graph visualization (100px max height, panned/zoomed)
  - Quick stats: "42 entities, 128 edges, 5 clusters"
  - Search box: find entity or path
  - Toggle: show/hide isolated nodes

**CLI:**
```bash
$ oracle memory graph show
Entity Graph:
├─ Oracle (8 memories, 12 edges)
├─ Redis (5 memories, 8 edges)
├─ Docker (3 memories, 6 edges)
...

$ oracle memory graph path Oracle Docker
Path: Oracle → deployment → Docker (2 hops)

$ oracle memory graph entity Redis
Redis:
├─ Mentions (13 times)
├─ Depends-on: cache-layer (1)
├─ Stored-in: persistence (1)
└─ Memories:
   └─ "Redis speeds up queries"
   └─ "In-memory key-value store"
```

**Acceptance:**
- Visualization <500ms load time (lazy-load on tab open)
- 500+ entity graphs render smoothly (Cytoscape handles it)
- Entity search: <100ms
- Path finding: <100ms (BFS cached)

---

## Separable / Bonus

- **Token leak detection:** Warn if single call exceeds $10 (tunable)
- **Cost alerts:** Email/Slack on daily spend > threshold
- **Provider health:** Periodic liveness checks (401 = key invalid, 5xx = provider down)
- **Offline mode:** If all providers down, use cached responses or error gracefully

---

## Not in v0.7.0 (defer to v0.8+)

- **Distributed orchestration:** Swarm-wide cost aggregation (needs coordinator service)
- **ML cost optimizer:** Auto-pick cheapest model for task (needs task classification)
- **Provider auto-fallback:** Seamless fail-over if one provider down (needs retry logic)
- **Memory graph learning:** Auto-extract entities from unstructured memory (needs NLP)

---

## Version Context

| Ver | Theme | Status |
|-----|-------|--------|
| 0.1 | Coordination | ✓ Complete |
| 0.2 | Runtime (daemon + SQLite) | ✓ Complete |
| 0.3 | Control Center | ✓ Complete |
| 0.4 | Human Control Plane | ✓ Complete |
| 0.5 | Remote Swarm | ✓ Complete |
| 0.6 | Memory Engine | ✓ Complete |
| **0.7** | **Advanced Features** | → Start here |
| 0.8+ | ML optimization, distributed accounting | Future |

---

## Testing & Validation

**Cost Tracking:**
- Mock call log: verify totals, per-agent breakdown, per-provider split
- Concurrency: 10 parallel agents, check cost accuracy (no race conditions)

**Provider Coverage:**
- Integration test per provider: smoke call to model list, single chat completion, streaming
- Fallback: if provider unavailable, verify auto-selection of next in chain

**Sandbox:**
- Bomb test: fork-bomb process, verify cgroup kills
- Network test: curl external URL, verify rejection
- Disk test: dd if=/dev/zero to /tmp, verify cap enforced

**Memory Graph:**
- 100+ entities: verify render <500ms, interactions snappy
- Path finding: verify <100ms for depth=5 graphs
- Entity drill: verify memory links load correctly

---

## Success Criteria

✅ Cost tracking: breakdown visibility, per-agent accountability
✅ Provider coverage: 7 providers available (anthropic, openai, codex, gemini, ollama, bedrock, vertex)
✅ Sandbox: process isolation, network denial, resource limits, verified in CI
✅ Graph viz: <500ms load, smooth interactions, accurate entity linking

---

## Effort Estimate

- **Cost tracking:** 3-4 days (schema, aggregation, CLI, dashboard)
- **Provider coverage:** 4-5 days (4 new providers × 1 day each, + fallback logic)
- **Sandbox:** 3-4 days (Docker integration, namespace fallback, testing)
- **Graph viz:** 2-3 days (React component, D3/Cytoscape, API endpoint)

**Total:** ~12-16 days (~3 weeks), deliverable in Q4 2026 depending on 0.6.0 stabilization.
