# Oracle MCP Quick Start Guide

## Step 1: Verify Oracle Installation

```bash
npm run build
node dist/cli.js doctor
```

Expected output:
```
OK  codex executable: codex-cli 0.144.6
OK  codex authentication: Logged in using ChatGPT
```

---

## Step 2: Setup MCP for Claude Code

Run this command in the project directory:

```bash
node dist/cli.js setup-mcp --client claude-code
```

This creates `.mcp.json` with the Oracle MCP server configuration.

**Then:** Restart Claude Code. You'll see `oracle_*` tools appear in the tool list.

---

## Step 3: Test Basic MCP Tools in Claude Code

Once Claude Code is restarted, try these tools:

### 3a. Ask a Question with Context
```json
{
  "tool": "oracle_ask",
  "input": {
    "question": "Summarize the Oracle MCP architecture",
    "files": ["README.md", "docs/architecture.md"]
  }
}
```

### 3b. Remember a Fact
```json
{
  "tool": "oracle_memory_remember",
  "input": {
    "content": "Oracle uses SQLite for messages, tasks, presence, workflows, Runtime events, and approvals",
    "tags": ["oracle", "architecture", "storage"]
  }
}
```

### 3c. Search Memory
```json
{
  "tool": "oracle_memory_search",
  "input": {
    "query": "How does Oracle store data?"
  }
}
```

### 3d. Register Yourself
```json
{
  "tool": "oracle_msg_register",
  "input": {
    "name": "my-claude-code-session",
    "role": "developer"
  }
}
```

### 3e. See Who's Online
```json
{
  "tool": "oracle_msg_agents",
  "input": {}
}
```

---

## Step 4: Run the Example Multi-Agent Workflow

### Terminal 1 - Lead (Planning)
```bash
node examples/workflow-dashboard.mjs lead
```

This creates 3 tasks for frontend, backend, and reviewer.

### Terminal 2 - Frontend Developer
```bash
node examples/workflow-dashboard.mjs frontend
```

Builds React component, checks off items, submits to lead.

### Terminal 3 - Backend Developer
```bash
node examples/workflow-dashboard.mjs backend
```

Builds API endpoints, checks off items, submits to lead.

### Terminal 4 - QA Engineer
```bash
node examples/workflow-dashboard.mjs reviewer
```

Runs integration tests, checks off items, submits to lead.

**Expected Flow:**
1. Lead creates 3 tasks
2. All agents start work `in_progress`
3. Agents message each other for coordination
4. Each agent verifies checklist items
5. Each agent submits to lead
6. Lead approves each task → `done`

---

## Step 5: Run Multi-Claude-Code Workflow

For a real multi-session test:

### Session A - Lead
```bash
# In Claude Code Terminal
node dist/cli.js identity setup -n "lead"
node dist/cli.js msg send -f "lead" -t "*" -b "Starting feature development"
```

### Session B - Frontend
```bash
# In different Claude Code instance
node dist/cli.js identity setup -n "frontend-agent"
node dist/cli.js msg inbox -a "frontend-agent"
node dist/cli.js task list --assignee "frontend-agent"
```

### Session C - Backend
```bash
# In yet another Claude Code instance
node dist/cli.js identity setup -n "backend-agent"
# Check for tasks/messages from other agents
```

Agents can now coordinate via:
- **Messages** (`oracle_msg_*`) — instant notifications
- **Tasks** (`oracle_task_*`) — structured work tracking
- **Memory** (`oracle_memory_*`) — shared knowledge across sessions

---

## How It Works Under the Hood

```
Claude Code Session A          Claude Code Session B          Claude Code Session C
├─ oracle-mcp server           ├─ oracle-mcp server           ├─ oracle-mcp server
└─ memory/messages/tasks        └─ memory/messages/tasks        └─ memory/messages/tasks
      ↓                              ↓                              ↓
      └──────────────────────────────────────────────────────────────┘
                              ~/.oracle/ (shared)
                         ├─ messages/
                         ├─ tasks/
                         ├─ agents/
                         └─ memory/
```

All agents on the same machine share:
- **Message bus** (`~/.oracle/messages/`) — for inter-agent communication
- **Task tracker** (`~/.oracle/tasks/`) — for coordinated work
- **Memory store** (`~/.oracle/memory/`) — for persistent knowledge

---

## Testing Each Component

### Test Memory
```bash
node dist/cli.js memory list
```

### Test Messaging
```bash
# Send
node dist/cli.js msg send -f "agent-a" -t "agent-b" -b "Hello"

# Receive
node dist/cli.js msg inbox -a "agent-b"

# Mark read
node dist/cli.js msg ack -a "agent-b" "<message-id>"
```

### Test Tasks
```bash
# Create
node dist/cli.js task create \
  --title "My Task" \
  --created-by "lead" \
  --assignee "worker" \
  --checklist "Item 1" "Item 2"

# List
node dist/cli.js task list

# Update
node dist/cli.js task update <id> -a worker --status in_progress --note "Working on it"

# Check off
node dist/cli.js task check <id> 0

# Submit
node dist/cli.js task submit <id> -a worker --summary "Done!"

# Approve
node dist/cli.js task close <id> -a lead
```

---

## Troubleshooting

### Oracle tools not showing in Claude Code
- Did you run `setup-mcp --client claude-code`?
- Did you restart Claude Code after setup?
- Check `.mcp.json` exists in project root

### Messages not appearing
- Ensure agents are registered: `oracle_msg_register { name: "...", role: "..." }`
- Check inbox: `oracle_msg_inbox { agent: "..." }`
- Messages stored in `~/.oracle/messages/`

### Tasks stuck on checklist
- Submit **blocks** if any item is unchecked
- Check all items before submitting: `oracle_task_checklist { id: "...", index: 0, checked: true }`

### Memory not found
- Wait for maintenance cycle (1 hour) or manually consolidate:
  ```bash
  node dist/cli.js memory consolidate
  ```

---

## Real-World Usage Examples

### Multi-Session Refactoring
```
Lead: Creates task "Refactor auth middleware"
  ├─ Assigns to Worker A (endpoint changes)
  ├─ Assigns to Worker B (tests)
  └─ Assigns to Worker C (docs)

Worker A, B, C work in parallel → each submits to Lead
Lead reviews all 3 → approves when all done
```

### Cross-Project Knowledge Sharing
```bash
# Session 1: Save learning
oracle_memory_remember {
  content: "Redis connection pool should be 50-100 connections",
  tags: ["redis", "performance", "pattern"],
  scope: "global"  # shared across projects!
}

# Session 2 (different project): Recall
oracle_memory_search {
  query: "Redis connection pool size",
  scope: "global"
}
→ Gets the fact from Session 1
```

### Task Verification Workflow
```bash
# Lead creates task with verification checklist
oracle_task_create {
  title: "Add rate limiting",
  checklist: [
    "Implement limiter",
    "Write unit tests",
    "Run load test (< 100ms p99)",
    "Update API docs"
  ]
}

# Worker can't report "done" unless ALL items checked
oracle_task_submit { ... }
→ BLOCKS if any item unchecked
→ Lead notified when truly ready
```

---

## Next Steps

1. ✅ Oracle installed & configured
2. ✅ MCP connected to Claude Code
3. 🚀 **Run the example workflow** with multiple Claude Code instances
4. 🚀 **Create your own tasks** and coordinate real work
5. 🚀 **Use `oracle_ask`** to consult with full project context

**Questions?** Check the full docs:
- `MESSAGING.md` — Messaging flow, wake-up hooks, troubleshooting
- `docs/architecture.md` — System design, data flow, threat model
- `.claude/skills/oracle-mcp-usage/SKILL.md` — Tool reference

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
