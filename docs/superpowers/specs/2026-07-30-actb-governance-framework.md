# Oracle ACTB Governance Framework — Architecture Spec

**Date**: 2026-07-30  
**Status**: Approved (Governance & Safety Architecture)  
**Framework**: Awareness • Control • Transform • Boundary (ACTB)

---

## 1. Overview & Philosophy

As autonomous AI coding agents grow in capability, they exhibit behaviors analogous to complex social entities: goal persistence, task delegation, tool usage, and potential drift or rogue execution. 

Inspired by psychological risk management principles used to align high-machiavellian or rogue behavioral patterns (**The Dark Triad Framework**), Oracle implements an explicit **ACTB (Awareness, Control, Transform, Boundary)** architectural alignment layer.

The ACTB Framework ensures that AI agents (Claude Code, opencode, Codex, Gemini CLI, Antigravity) operate within auditable, predictable, and resilient safety envelopes without sacrificing speed or multi-agent autonomy.

---

## 2. The 4 Pillars of ACTB Governance

```
                    ┌─────────────────────────────────────────┐
                    │            ACTB GOVERNANCE              │
                    └────────────────────┬────────────────────┘
                                         │
        ┌───────────────────┬────────────┴───────┬───────────────────┐
        ▼                   ▼                    ▼                   ▼
 ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
 │  AWARENESS   │    │   CONTROL    │    │  TRANSFORM   │    │   BOUNDARY   │
 │ Observability│    │ Guardrails & │    │ Synthesis &  │    │ Containment  │
 │ & Audit Chain│    │ Approval Gate│    │ Consolidation│    │ & Verification│
 └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

### Pillar I: Awareness (System Observability & Behavioral Visibility)

**Goal**: Full visibility into agent actions, token costs, memory mutation events, and inter-agent communication.

- **Tamper-Evident Audit Logging**: Every tool execution, file write, and bash command executed by `oracle agent` is hashed and written to schema v8 audit logs (`sandbox_runs`, file mutation logs).
- **Cost & Token Accounting**: `CostTracker` records token spend per provider, per model, and per agent (`oracle usage`), detecting runaway costs before budgets break.
- **Presence & Standby Monitoring**: Agent sessions send heartbeats and presence state (`oracle msg watch`, `oracle_msg_heartbeat`), making agent status transparent to human leads and peer sessions.
- **CDP Diagnostics**: ChatGPT Browser Mode logs execution-context changes, DOM selector health, and takes diagnostic screenshots upon unexpected UI changes.

### Pillar II: Control (Policy Guardrails & Human-in-the-Loop Approval)

**Goal**: Enforce deterministic execution limits and human approval gates for high-risk operations.

- **Approval Policies**: `oracle agent` supports approval modes (`off`, `risky`, `all-mutations`). Risky operations (e.g. system commands, out-of-workspace bash commands) pause execution and await approval from the Control Center inbox.
- **Human Control Center**: Interactive terminal TUI (`oracle control`) and authenticated Web Dashboard (`oracle control url`) provide real-time approval buttons, task pause/resume, and scheduler job management.
- **Execution Ceilings**: Hard step caps (`--max-steps`, default 20, max 50) and command timeout limits prevent infinite loops.
- **Budget Threshold Warnings**: Automatic 80% budget warnings and hard exit enforcement when cost limits are exceeded.

### Pillar III: Transform (Synthesis, Consolidation & Persona Adaptation)

**Goal**: Convert raw, transient agent interactions into structured, durable knowledge while maintaining safety.

- **Memory Auto-Consolidation**: Raw working memories are background-processed every 1 hour. Overlapping memories (Jaccard similarity ≥ 0.3) are merged, stale memories are pruned, and frequently accessed facts are promoted to durable insights and compiled into topic-based Wiki pages (`oracle memory consolidate`).
- **Soul Persona Routing**: Contextual personality prompts (`~/.oracle/souls/`) adapt tone (`engineer`, `socratic`, `witty`) to ensure answers are constructive, cited, and grounded.
- **Response Stabilization & Self-Healing**: Browser Mode transforms volatile web UI streaming into finalized, verified outputs (`hasCompletionAction` check with `Page.reload` self-healing on UI freeze).

### Pillar IV: Boundary (Containment, Scoping & Verification Gates)

**Goal**: Strict boundaries around filesystem mutation, browser profiles, inter-agent permissions, and completion claims.

- **Workspace Path Containment**: Filesystem operations are strictly confined to the project root using `resolveInWorkspace`. Any attempt to escape via symlinks or `..` path traversal is rejected immediately.
- **Checklist Verification Gate**: `oracle_task_submit` blocks moving a task to `review` state until every declared checklist item is empirically verified. Claims of completion without checked items are refused.
- **Isolated Browser Automation Profile**: ChatGPT Browser Mode uses an isolated Chrome profile (`~/.oracle/chrome-profile/`) with dynamic debugging ports, preventing attachment to personal Chrome instances and guaranteeing zero cookie export.
- **Project-Scoped Remote Swarm Tokens**: Remote agent connections are authenticated with project- and agent-scoped tokens, exposing coordination channels without remote shell or file mutation access.

---

## 3. Codebase Component Mapping

| ACTB Pillar | Implementation Files | Core Classes / Services |
|---|---|---|
| **Awareness** | `src/observability/`, `src/runtime/api.ts`, `src/messaging/` | `CostTracker`, `AuditLogger`, `SwarmService` |
| **Control** | `src/control/`, `src/agent/loop.ts`, `src/auth/` | `ApprovalInbox`, `AgentLoop`, `ControlCenterService` |
| **Transform** | `src/memory/`, `src/wiki/`, `src/backends/chatgpt-browser/` | `EntityGraph`, `MemoryConsolidator`, `ResponseMonitor` |
| **Boundary** | `src/agent/service.ts`, `src/tasks/`, `src/runtime/swarmService.ts` | `resolveInWorkspace`, `TaskTracker`, `SwarmAuth` |

---

## 4. Summary & Integration

The ACTB Framework provides Oracle with a clear, robust architecture for agent governance. By embedding Awareness, Control, Transform, and Boundary across all MCP tools, CLI subcommands, and daemon processes, Oracle remains a safe, dependable coordination layer for multi-agent software engineering.
