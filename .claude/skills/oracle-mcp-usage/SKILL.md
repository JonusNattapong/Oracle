---
name: Oracle MCP Usage Guide
description: How to use Oracle MCP tools in Claude Code for consultation, memory, messaging, and task tracking
metadata:
  type: skill
---

# Oracle MCP Usage Guide

Oracle gives you access to 60+ MCP tools for multi-agent coordination, persistent memory, and autonomous consultation. Use these tools to:

## Quick Reference

### 💬 Ask a Question (with context)

```
oracle_ask {
  question: "Why is the Dashboard slow?",
  files: ["src/**/*.ts"],
  conversationId: "session-123"  // optional: recall prior Q&A
}
```

**Returns:** Grounded answer citing code + memory + web + docs

---

### 🧠 Memory Management

Save facts that persist across sessions:

```
// Save a fact
oracle_memory_remember {
  content: "Service X uses connection pool with 50 max connections",
  tags: ["database", "performance", "service-x"]
}

// Search memory
oracle_memory_search {
  query: "What databases do we use?",
  limit: 5
}

// See related facts (entity graph)
oracle_memory_graph_query {
  entity: "Service X",
  depth: 2
}
```

---

### 📨 Message Other Agents

Send/receive messages for coordination:

```
// Register yourself
oracle_msg_register {
  name: "claude-code-worker-1",
  role: "backend developer"
}

// Send a message
oracle_msg_send {
  to: "claude-code-worker-2",
  body: "I've finished the auth refactor, ready for integration test"
}

// Check inbox
oracle_msg_inbox {
  agent: "claude-code-worker-1"
}

// Mark as read
oracle_msg_ack {
  ids: ["msg-id-123", "msg-id-456"]
}

// Broadcast to everyone
oracle_msg_send {
  to: "*",
  body: "Starting deployment in 10 minutes"
}
```

---

### ✅ Task Planning & Verification

Create, track, and verify work with checklists:

```
// Create a task
oracle_task_create {
  title: "Refactor auth middleware",
  createdBy: "lead",
  assignee: "worker-1",
  checklist: [
    "Remove session token storage",
    "Add JWT validation",
    "Update compliance docs"
  ]
}

// Update progress
oracle_task_update {
  id: "task-id-123",
  agent: "worker-1",
  status: "in_progress",
  note: "Implementing JWT, halfway done"
}

// Check off verification items
oracle_task_checklist {
  id: "task-id-123",
  agent: "worker-1",
  index: 0,
  checked: true
}

// Submit for review (blocks if items unchecked)
oracle_task_submit {
  id: "task-id-123",
  agent: "worker-1",
  summary: "All items done. Ready for integration test."
}

// Approve or reject
oracle_task_close {
  id: "task-id-123",
  agent: "lead",
  // approve (default)
  // or reject:
  reject: false,
  note: "Approved. Merging now."
}

// View task board
oracle_task_board {
  createdBy: "lead",
  activeOnly: true
}
```

---

## Real-World Workflow Example

### Scenario: Multi-Agent Feature Development

**Setup:**
- `claude-code-lead`: Plans work, creates tasks
- `claude-code-frontend`: Builds React components
- `claude-code-backend`: Builds API endpoints
- `claude-code-reviewer`: Runs integration tests

### Flow:

**1. Lead creates tasks**
```
oracle_task_create {
  title: "Build Dashboard",
  assignee: "claude-code-frontend",
  checklist: ["Component design", "Tests", "Docs"]
}
→ Message sent automatically to frontend agent
```

**2. Agents coordinate via messaging**

Frontend agent:
```
oracle_msg_send {
  to: "claude-code-backend",
  body: "I need /api/dashboard endpoint by EOD"
}
```

Backend agent receives message:
```
oracle_msg_inbox {
  agent: "claude-code-backend"
}
→ See frontend's request
```

**3. Agents verify before reporting done**

Frontend agent:
```
oracle_task_checklist { id: "...", index: 0, checked: true }  // Component design
oracle_task_checklist { id: "...", index: 1, checked: true }  // Tests
oracle_task_checklist { id: "...", index: 2, checked: true }  // Docs

oracle_task_submit {
  id: "...",
  agent: "claude-code-frontend",
  summary: "Dashboard component ready, all tests green"
}
→ Lead notified automatically
```

**4. Lead reviews and closes**
```
oracle_task_close {
  id: "...",
  agent: "claude-code-lead"
  // Approves automatically; agents get notified
}
```

---

## Key Features

### ✅ Verification Gate
- `oracle_task_submit` **blocks** if any checklist item is unchecked
- Prevents premature "done" claims
- Lead knows work is truly verified

### 💾 Persistent Memory
- Every `oracle_memory_*` call is saved
- Future questions auto-reference related facts
- Entity graph links related knowledge

### 🔄 Atomic Storage
- All messages/tasks/memory stored as JSON in `~/.oracle/`
- No database, no daemon
- Survives across Claude Code sessions

### 📍 Presence Tracking
- Agents see who's active via `oracle_msg_agents`
- Automatically updated on every action
- Great for "is backend-agent working right now?"

---

## Tips for Multi-Agent Coordination

1. **Always register first**
   ```
   oracle_msg_register { name: "my-agent-name", role: "my-role" }
   ```
   Then check what other agents are active:
   ```
   oracle_msg_agents {}
   ```

2. **Use threads for long conversations**
   ```
   oracle_msg_send { to: "agent-b", body: "...", replyTo: "msg-id-123" }
   ```

3. **Memory scopes**
   - Default: `scope: "project"` → stored in `.oracle-memory/` (project root)
   - Pass `scope: "global"` for cross-project knowledge

4. **Task lifecycle**
   - `pending` → `in_progress` → `review` → `done` (or `blocked`, `cancelled`)
   - Can only submit when all checklist items are checked

5. **Debugging**
   - Run `oracle doctor` to verify setup
   - Check `~/.oracle/messages/`, `~/.oracle/tasks/`, `~/.oracle/memory/` for raw JSON
   - Use `oracle msg inbox --wait` to block until messages arrive

---

## Full Tool List

| Category | Tools |
|----------|-------|
| Consultation | `oracle_ask`, `oracle_sessions`, `oracle_session_get` |
| Memory (18) | `oracle_memory_*` (remember, list, search, update, clear, stats, consolidate, prune, promote, maintenance, reflect, wiki_*, graph_*) |
| Messaging (6) | `oracle_msg_register`, `oracle_msg_send`, `oracle_msg_inbox`, `oracle_msg_ack`, `oracle_msg_agents`, `oracle_msg_thread` |
| Tasks (8) | `oracle_task_create`, `oracle_task_list`, `oracle_task_get`, `oracle_task_update`, `oracle_task_checklist`, `oracle_task_submit`, `oracle_task_close`, `oracle_task_board` |
| Agents | `oracle_agent` (autonomous sandbox) |
| Docs & Web | `oracle_docs_*`, `oracle_web_search`, `oracle_web_fetch` |
| Identity & System | `oracle_identity_*`, `oracle_persona_set`, `oracle_doctor`, `oracle_skills`, `oracle_oracle_*` |

---

## Next Steps

1. **Restart Claude Code** to load the MCP server
2. **Use `oracle_ask`** to query with full project context
3. **Set up multi-agent tasks** using `oracle_task_*`
4. **Enable real-time wake-ups** with `oracle msg watch`
