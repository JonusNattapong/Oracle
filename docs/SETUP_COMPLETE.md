# ✅ Oracle MCP Setup Complete

## What We've Done

### 1. ✅ Verified Oracle Installation
- Built TypeScript → JavaScript
- Tested CLI: `oracle doctor` ✓
- Verified Codex authentication ✓

### 2. ✅ Setup MCP for Claude Code
- Generated `.mcp.json` configuration
- MCP server points to `dist/mcp.js`
- Workspace root correctly configured

### 3. ✅ Tested All Core Features
- **Memory:** Listed, searched, stored facts
- **Messaging:** Created message bus, sent messages between agents
- **Tasks:** Created, tracked, verified, submitted, approved workflow
- **Multi-Agent:** 4 agents working simultaneously (test-agent, frontend, backend, reviewer)

### 4. ✅ Created Documentation
- `ORACLE_QUICKSTART.md` — Step-by-step guide
- `SETUP_CHECKLIST.md` — Verification checklist
- `CLAUDE_CODE_USAGE.md` — How to use in Claude Code
- `.claude/skills/oracle-mcp-usage/SKILL.md` — Tool reference
- `examples/workflow-dashboard.mjs` — Working example script

---

## Files Created / Updated

```
Oracle-Ecosystems/
├─ .mcp.json                                    ← MCP server config for Claude Code
├─ .oracle/config.json                          ← Project-level Oracle config
├─ ORACLE_QUICKSTART.md                         ← Start here
├─ SETUP_CHECKLIST.md                           ← Verification list
├─ CLAUDE_CODE_USAGE.md                         ← How to use in Claude Code
├─ SETUP_COMPLETE.md                            ← This file
├─ .claude/skills/
│  └─ oracle-mcp-usage/SKILL.md                ← Detailed tool reference
└─ examples/
   └─ workflow-dashboard.mjs                   ← Multi-agent workflow example
```

---

## Current Status

| Component | Status | Details |
|-----------|--------|---------|
| **Oracle CLI** | ✅ Working | `npm run build && node dist/cli.js doctor` |
| **MCP Server** | ✅ Ready | Points to `dist/mcp.js` |
| **Claude Code Config** | ✅ Set | `.mcp.json` created |
| **Memory System** | ✅ Tested | Facts persist in `~/.oracle/memory/` |
| **Message Bus** | ✅ Tested | Messages in `~/.oracle/messages/` |
| **Task Tracker** | ✅ Tested | Tasks in `~/.oracle/tasks/` |
| **Multi-Agent** | ✅ Tested | 4 agents coordinated successfully |

---

## What Needs to Be Done Now

### 👉 IMMEDIATE: Start Using in Claude Code

**Step 1: Restart Claude Code**
```bash
# Close Claude Code completely
# Reopen it
# In terminal, verify tools appear:
# Try typing "oracle_" to see autocomplete
```

**Step 2: Try One Tool**
```json
// In Claude Code, call oracle_ask with your first question:
Tool: oracle_ask
Input: {
  "question": "What is the Oracle project?",
  "files": ["README.md"]
}
```

**Step 3: Remember a Fact**
```json
Tool: oracle_memory_remember
Input: {
  "content": "Oracle MCP is set up and working on this project",
  "tags": ["oracle", "setup", "complete"]
}
```

### 🚀 OPTIONAL: Test Multi-Agent Workflow

Run the example workflow with 4 terminals:

```bash
# Terminal 1: Lead
node examples/workflow-dashboard.mjs lead

# Terminal 2: Frontend
node examples/workflow-dashboard.mjs frontend

# Terminal 3: Backend
node examples/workflow-dashboard.mjs backend

# Terminal 4: Reviewer
node examples/workflow-dashboard.mjs reviewer
```

All 3 work agents will:
- Pick up their tasks from lead
- Message each other
- Complete verification checklists
- Submit to lead
- Lead approves → all done

---

## Storage & Data

All Oracle data stored locally:

```
~/.oracle/
├─ messages/          # Message bus (inter-agent communication)
├─ tasks/             # Task tracker (work assignments + verification)
├─ agents/            # Presence registry (who's online)
├─ memory/            # Persistent knowledge base (facts + entity graph)
├─ runtime/           # SQLite scheduler/events + daemon state/log
└─ .sessions/         # Consultation history (optional)
```

**Zero external services.** Coordination stores use atomic local files;
Runtime uses a local SQLite database.

---

## Next: Use Cases

### Use Case 1: Persistent Memory Across Sessions

**Session 1:** Learn something
```json
Tool: oracle_memory_remember
Input: {
  "content": "Dashboard performance issue is in the card rendering loop",
  "tags": ["dashboard", "performance", "bug"]
}
```

**Session 2 (later):** Recall automatically
```json
Tool: oracle_ask
Input: {
  "question": "What performance issues do we have?"
}
```

Oracle includes the memory from Session 1 in its answer.

---

### Use Case 2: Ask with Full Context

```json
Tool: oracle_ask
Input: {
  "question": "Review this code for security issues",
  "files": ["src/**/*.ts"],
  "conversationId": "security-review-1"
}
```

Oracle reads all your TS files, checks memory for prior security findings, searches your docs, and gives you a thorough review.

---

### Use Case 3: Multi-Session Coordination

**Session A (Lead):**
```json
Tool: oracle_task_create
Input: {
  "title": "Implement password reset feature",
  "assignee": "frontend-worker",
  "checklist": ["Design flow", "Build form", "Add tests"]
}
```

**Session B (Frontend Worker):**
```json
Tool: oracle_msg_inbox
Input: { "agent": "frontend-worker" }
```
Sees the task, starts working...

```json
Tool: oracle_msg_send
Input: {
  "to": "backend-worker",
  "body": "Need a POST /auth/password-reset endpoint"
}
```

**Session C (Backend Worker):**
```json
Tool: oracle_msg_inbox
Input: { "agent": "backend-worker" }
```
Sees frontend's request, builds the endpoint...

Both submit work to lead. Lead approves. Feature done!

---

## FAQs

**Q: Do I need to commit these docs?**
A: Yes! They're part of setting up Oracle for your team. Commit:
- `.mcp.json`
- `.oracle/config.json`
- `ORACLE_QUICKSTART.md`
- `CLAUDE_CODE_USAGE.md`
- `examples/workflow-dashboard.mjs`

Ignore: `~/.oracle/` (that's local agent state)

**Q: Can I use this with multiple machines?**
A: Yes. Start Runtime with an explicit remote binding, issue one scoped token
per agent, and use `oracle connect` plus `oracle team ...`. Put Runtime behind
HTTPS or an encrypted private network. See [Remote Swarm](remote-swarm.md).

**Q: Does memory get too big?**
A: Memory auto-consolidates every hour (removes duplicates, promotes frequently-used facts). You can manually prune old facts: `oracle memory prune --days 30`

**Q: What if I restart Claude Code?**
A: All memory, messages, and tasks persist in `~/.oracle/`. When you restart, agents re-register and see their pending work.

**Q: Can I use this with other MCP clients?**
A: Yes! The same `.mcp.json` can wire Oracle into opencode, Codex CLI, or any MCP-compatible client. Just point them at the same `ORACLE_WORKSPACE_ROOT`.

---

## Commands to Keep Handy

```bash
# Verify installation
node dist/cli.js doctor

# List all memory
node dist/cli.js memory list

# Search memory
node dist/cli.js memory search "query"

# Consolidate memory (remove duplicates)
node dist/cli.js memory consolidate

# List all messages
node dist/cli.js msg inbox -a "agent-name"

# List all tasks
node dist/cli.js task list

# View task detail
node dist/cli.js task get <task-id>

# Example multi-agent workflow
node examples/workflow-dashboard.mjs lead
node examples/workflow-dashboard.mjs frontend
node examples/workflow-dashboard.mjs backend
node examples/workflow-dashboard.mjs reviewer
```

---

## Troubleshooting Quick Links

- **Oracle tools not showing in Claude Code?** → See "Setup" section in `SETUP_CHECKLIST.md`
- **Messages not working?** → See "Messaging Bus" in `SETUP_CHECKLIST.md`
- **Tasks won't submit?** → See "Test Each Component" → Task Tracker in `SETUP_CHECKLIST.md`
- **How do I use oracle_ask?** → See `CLAUDE_CODE_USAGE.md` → Example 1
- **How do I coordinate 3 Claude Code sessions?** → See `CLAUDE_CODE_USAGE.md` → Real Workflow

---

## What's Next?

1. **Today:** Restart Claude Code, try `oracle_ask` once
2. **Tomorrow:** Use memory + messaging to coordinate 2 Claude Code sessions
3. **This Week:** Run the full 4-agent workflow example
4. **This Month:** Build your own multi-agent coordination patterns

---

## Success Checklist

You'll know Oracle is fully working when:

- [ ] Claude Code restarted and `oracle_*` tools appear
- [ ] You successfully called `oracle_ask` with context
- [ ] You saved a fact with `oracle_memory_remember`
- [ ] You sent a message between two agents
- [ ] You created a task, checked off items, and submitted it
- [ ] You ran the example workflow with 4 terminals
- [ ] Multiple Claude Code instances coordinated work

**Congratulations! 🎉 Oracle MCP is ready to use.**

---

## Questions?

- **Setup issues?** Check `SETUP_CHECKLIST.md`
- **How to use?** Read `CLAUDE_CODE_USAGE.md`
- **Tool reference?** See `.claude/skills/oracle-mcp-usage/SKILL.md`
- **Example?** Run `examples/workflow-dashboard.mjs`
- **Architecture?** Read `docs/architecture.md`

**Let's build something amazing with Oracle! 🚀**

---
*Oracle — A persistent coordination layer for AI coding agents*
*https://github.com/OraclePersonal/Oracle*
