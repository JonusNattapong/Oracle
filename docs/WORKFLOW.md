---
title: Standard Working Process (SOP)
---

# Oracle Standard Working Process (SOP) & Workflows

This document details the standard operating procedures and workflows for humans and AI agents interacting with **Oracle-Ecosystems**.

---

## 1. Overview of System Workflows

Oracle operates across three core lifecycle phases:

1. **Session & Identity Phase**: Establish context, agent persona, and recall past knowledge.
2. **Execution Phase (Single Agent)**: Investigate code, create plans, execute mutations inside sandboxes, and perform self-reviews.
3. **Coordination Phase (Multi-Agent)**: Distribute tasks, track progress across agents, verify completion via gates, and report results.

```mermaid
flowchart TD
    Start([Session Start]) --> Identity[Identity & Roster Check]
    Identity --> SelectType{Task Type?}

    SelectType -->|Single Agent / Q&A| SingleLoop[Single Agent Execution Cycle]
    SelectType -->|Multi-Agent Task| TaskLoop[Multi-Agent Coordination Cycle]

    SingleLoop --> Flow[oracle_run / Flow Controller]
    Flow --> Ask[oracle_ask / Consultation]
    Flow --> Research[Web Search / Deep Research]
    Flow --> Plan[Plan + Approval]
    Plan --> Agent[oracle_agent Loop]

    Agent --> ReviewPlan[Plan / Read-Only Pass]
    ReviewPlan --> Execute[Sandbox Execution & Audit]
    Execute --> Review[Self-Review Pass]

    TaskLoop --> TaskCreate[Create Task with Checklist]
    TaskCreate --> TaskProgress[In-Progress Updates]
    TaskProgress --> TaskSubmit[Submit Task Verification Gate]
    TaskSubmit --> TaskClose[Reviewer Close & Approve]

    Ask --> MemorySave[Memory Consolidation]
    Review --> MemorySave
    TaskClose --> MemorySave
    MemorySave --> End([Session End])
```

---

## 2. Phase 1: Session & Identity Onboarding

Every agent or CLI session MUST establish its identity and check for background updates or unread messages before executing work.

### Sequence Flow

```mermaid
sequenceDiagram
    autonumber
    actor User/Agent
    participant IdentityStore as Identity & Roster
    participant MessageBus as Message Bus (~/.oracle)

    User/Agent->>IdentityStore: oracle_identity_show / oracle_msg_register
    IdentityStore-->>User/Agent: Returns Profile + Active Agents Roster + Unread Count
    User/Agent->>MessageBus: oracle_msg_inbox (agent: "me")
    MessageBus-->>User/Agent: Returns Unread Messages
```

> [!NOTE]
> Calling `oracle_msg_register` is idempotent and automatically updates the agent's `lastSeen` timestamp in the shared store.

---

## 3. Phase 2: Single-Agent Execution Cycle

When an MCP host is available, use `oracle_run` as the single entry point. It
classifies the request and keeps the safe plan-before-action boundary. Use the
lower-level tools directly when a caller already knows the desired mode.

### Tool Selection Rule

| Mode | Tool / Command | File Mutations | Primary Purpose |
|---|---|---|---|
| **Unified flow** | `oracle_run` | Depends | Classifies Q&A, research, planning, and approved action handoff |
| **Consultation** | `oracle_ask` | ❌ No | Architecture Q&A, code analysis, code review, advice |
| **Investigation** | `oracle_agent --read-only` | ❌ No | Deep codebase search without altering any files |
| **Planned Coding** | `oracle_agent --plan` | ✅ Yes (after approval) | Read-only investigation pass first → User approval → Mutate files |
| **Autonomous Coding** | `oracle_agent --review` | ✅ Yes | Full tool loop (read/write/edit/bash) with post-execution self-review |

### Execution & Safety Boundaries

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant AgentLoop as Agent Loop (loop.ts)
    participant Sandbox as Execution Sandbox
    participant Audit as Audit Logger (audit.ts)

    Client->>AgentLoop: oracle_agent(prompt, maxSteps)
    loop Tool Steps (up to maxSteps)
        AgentLoop->>AgentLoop: Decide Tool Call (read_file / edit_file / bash)
        alt Mutating Operation
            AgentLoop->>Audit: Record Mutation Hash & Diff
            AgentLoop->>Sandbox: Execute in Workspace / Docker
            Sandbox-->>AgentLoop: Result
        else Read-Only Operation
            AgentLoop->>Sandbox: Read / Search Workspace
            Sandbox-->>AgentLoop: Result
        end
        AgentLoop->>AgentLoop: Save Checkpoint (~/.oracle/checkpoints/)
    end
    AgentLoop-->>Client: Final Output + Checkpoint ID + Audit Summary
```

> [!IMPORTANT]
> If a run is interrupted by network issues or step limits, resume execution seamlessly using `resumeId: "<checkpoint-id>"`.

---

## 4. Phase 3: Multi-Agent Coordination Cycle

For multi-agent workflows, task execution is governed by a **Verification Gate** to guarantee quality.

### Task Lifecycle States

```
[ pending ] ──► [ in_progress ] ──► [ review ] ──► [ done ]
                      ▲                   │
                      └─ (rejected) ──────┘
```

### Verification Gate Flow

```mermaid
sequenceDiagram
    autonumber
    actor LeadAgent as Lead Agent
    actor WorkerAgent as Worker Agent
    participant TaskStore as Task Store (~/.oracle/runtime/oracle.db)

    LeadAgent->>TaskStore: oracle_task_create (title, assignee, checklist: ["item1", "item2"])
    TaskStore-->>WorkerAgent: Auto-message: New Task Assigned

    WorkerAgent->>TaskStore: oracle_task_update (status: "in_progress")
    WorkerAgent->>WorkerAgent: Perform work items
    WorkerAgent->>TaskStore: oracle_task_checklist (index: 0, done: true)
    WorkerAgent->>TaskStore: oracle_task_checklist (index: 1, done: true)

    WorkerAgent->>TaskStore: oracle_task_submit (summary: "Done")
    alt Unchecked Items Exist
        TaskStore-->>WorkerAgent: ❌ REJECTED: Mandatory checklist items incomplete
    else All Items Checked
        TaskStore->>TaskStore: Transition status to "review"
        TaskStore-->>LeadAgent: Auto-message: Task Ready for Review
    end

    LeadAgent->>TaskStore: oracle_task_close (approved: true)
    TaskStore->>TaskStore: Transition status to "done"
```

> [!WARNING]
> Calling `oracle_task_submit` without completing all checklist items will be rejected by the system gate.

---

## 5. Phase 4: Knowledge & Memory Persistence

To maintain long-term repository knowledge across sessions:

1. **Auto-Consolidation**: Facts and insights recorded during execution are grouped and deduplicated via BM25 and vector search.
2. **Wiki Compilation**: Topic-based wiki pages under `.oracle-memory/` summarize architectural decisions.
3. **Session Checkpoints**: Maintain conversation continuity across restarts.

---

## 6. Summary Checklist for Agents

- [ ] Call `oracle_identity_show` and `oracle_msg_register` at session start.
- [ ] Prefer `oracle_run` for mixed requests; use `oracle_ask` for read-only advice and `oracle_agent` for direct coding loops.
- [ ] Always check off task checklist items before calling `oracle_task_submit`.
- [ ] Perform self-review (`--review`) before declaring tasks complete.
- [ ] Save relevant facts or insights to working memory before terminating the turn.
