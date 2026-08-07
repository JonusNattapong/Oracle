# Oracle Usage Guide for AI Agents

**How to use Oracle CLI and MCP correctly. Every command, every time.**

This guide ensures AI agents use Oracle's capabilities efficiently and safely.

---

## 🎯 Core Workflows

### Workflow 1: Ask a Question (Safe)

**When to use:** Need advice, analysis, code review  
**Safety:** Read-only, no changes made

```bash
oracle ask "Question about code or project" \
  -f "src/**/*.ts"                           # Files to include
  --include-docs                             # Search .oracle/docs/
```

**What happens:**
1. ✅ Reads files (respects .gitignore)
2. ✅ Scans for secrets
3. ✅ Retrieves memory
4. ✅ Calls model
5. ✅ Saves session
6. ❌ Does NOT modify files

**Examples:**
```bash
oracle ask "Explain the auth flow" -f "src/auth/**/*.ts"
oracle ask "Find performance bottlenecks" -f "src/api/**/*.ts"
oracle ask "Review error handling" -f "src/**/*.test.ts"
```

---

### Workflow 2: Read-Only Investigation

**When to use:** Understand a problem before fixing  
**Safety:** Agent explores, reads only, proposes solutions

```bash
oracle agent "Find the root cause of the timeout bug" \
  --read-only                 # Can't modify files
```

**What happens:**
1. ✅ Agent reads code, tests, git history
2. ✅ Returns diagnosis and recommendations
3. ❌ Does NOT make changes
4. ✅ Safe to run on any branch

**Example:**
```bash
oracle agent "Investigate why scheduler tests are flaky" --read-only
# Output: "Found race condition in line 42 of scheduler.ts..."
```

---

### Workflow 3: Propose Changes (Plan First)

**When to use:** Make changes, but review first  
**Safety:** Shows plan, waits for approval

```bash
oracle agent "Fix the null pointer exception in user service" \
  --plan                      # Show what you'll do first
```

**What happens:**
1. ✅ Agent proposes a plan
2. ⏸ YOU review
3. If approved:
   ```bash
   oracle agent "Fix the null pointer exception in user service" \
     --confirm
   ```
4. ✅ Agent makes changes
5. ✅ Runs tests
6. ✅ Shows diff

---

### Workflow 4: Execute With Review (Full Loop)

**When to use:** Complex changes, need confidence  
**Safety:** Plan + Execute + Review all in one

```bash
oracle agent "Add input validation to all API handlers" \
  --plan          # Show the plan
  --review        # Auto-review generated code
  --approval-mode risky
```

**What happens:**
1. ✅ Shows plan → YOU approve
2. ✅ Executes → makes changes
3. ✅ Runs tests
4. ✅ Auto-reviews for bugs and security
5. ✅ Shows summary and diff

---

## 🧠 Using Memory Correctly

### Store Facts

```bash
# ✅ Good: Store architectural decisions
oracle memory add fact "auth-strategy" \
  "We use JWT tokens stored in httpOnly cookies. \
   Refresh tokens in Redis. Session timeout: 24h."

# ✅ Good: Store common patterns
oracle memory add fact "api-error-handling" \
  "All API endpoints return {success, data, error}. \
   Use ErrorHandler middleware."

# ❌ Wrong: Don't store secrets
oracle memory add fact "api-key" "sk-1234567890..."  # DON'T!
```

### Retrieve Memory

```bash
# Memory is automatic in oracle ask/agent
oracle ask "How do we handle authentication?"
# Oracle: *automatically recalls auth-strategy fact*

# Force no memory (when sensitive)
oracle ask "..." --no-memory

# See what's stored
oracle memory list
```

### Verify Memory

```bash
# Check which memories are used
oracle ask "Question" --show-sources

# See anchored memories (tied to files)
oracle memory verify --anchors
```

---

## ⚙️ MCP Tools (For Claude Code, etc.)

### oracle_ask (Grounded Q&A)

```json
{
  "prompt": "Explain the payment flow",
  "include_docs": true,
  "include_memory": true,
  "no_memory": false
}
```

Returns: Answer with sources

### oracle_agent (Autonomous Loop)

```json
{
  "prompt": "Fix the flaky test and verify",
  "read_only": false,
  "max_steps": 20,
  "mode": "auto"
}
```

**Mode options:**
- `"auto"` — Plan first if mutating, then execute
- `"ask"` — Q&A only
- `"plan"` — Plan mode, wait for approval
- `"act"` — Execute directly (careful!)

### oracle_memory_remember (Store Facts)

```json
{
  "agent": "me",
  "type": "fact",
  "title": "payment-processing",
  "content": "We use Stripe. Webhooks in /api/webhooks/stripe. Test mode available.",
  "anchors": [
    {
      "path": "src/api/payment.ts",
      "lines": [1, 50]
    }
  ]
}
```

### oracle_docs_search (Knowledge Base)

```json
{
  "query": "How do we structure React components?",
  "limit": 5
}
```

Returns: Top 5 relevant doc sections

---

## 🚫 Common Mistakes

### ❌ Mistake 1: Using `oracle ask` for mutations

```bash
# WRONG: agent isn't doing anything
oracle ask "Refactor the authentication module"

# RIGHT: use oracle agent
oracle agent "Refactor the authentication module" --plan --review
```

### ❌ Mistake 2: No --plan before risky changes

```bash
# WRONG: goes straight to execution
oracle agent "Rewrite the database schema" --confirm

# RIGHT: see the plan first
oracle agent "Rewrite the database schema" --plan
# Then review, then --confirm
```

### ❌ Mistake 3: Storing secrets in memory

```bash
# WRONG
oracle memory add fact "aws-key" "AKIAIOSFODNN7EXAMPLE"

# RIGHT: Never store secrets
# Store safe facts only: architecture, decisions, patterns
```

### ❌ Mistake 4: Calling agent with no limits

```bash
# WRONG: could run forever
oracle agent "Refactor everything"

# RIGHT: Scope the work
oracle agent "Refactor the user module" --max-steps 20
```

### ❌ Mistake 5: Not using --read-only for investigation

```bash
# WRONG: agent can change files while investigating
oracle agent "Debug the memory leak"

# RIGHT: investigate safely first
oracle agent "Debug the memory leak" --read-only
# Then: oracle agent "Fix it" --plan --review
```

---

## ✅ Best Practices

### 1. Always Use --plan for Changes

```bash
# Good workflow:
oracle agent "task" --plan
# Review the plan
oracle agent "task" --confirm
```

### 2. Store Architectural Decisions in Memory

```bash
oracle memory add fact "database-choice" \
  "PostgreSQL 15, hosted on RDS. \
   Migrations in src/db/migrations/. \
   Use Prisma ORM for queries."
```

### 3. Use --read-only First

```bash
# For bugs: investigate first
oracle agent "Diagnose the issue" --read-only

# THEN fix
oracle agent "Fix the issue" --plan --review
```

### 4. Verify Tests After Changes

```bash
oracle agent "Add new feature and verify tests pass" \
  --plan --review
# Agent will run tests automatically
```

### 5. Document Non-Obvious Patterns

```bash
oracle memory add fact "error-handling-strategy" \
  "Always wrap async in try-catch. \
   Log to sentry. Return 500 with generic message to client."
```

---

## 📋 Command Reference

| Task | Command |
|------|---------|
| **Ask question** | `oracle ask "Q" -f "src/**/*.ts"` |
| **Investigate (safe)** | `oracle agent "task" --read-only` |
| **Plan changes** | `oracle agent "task" --plan` |
| **Execute (safe)** | `oracle agent "task" --plan --review` |
| **Quick fix** | `oracle agent "task" --confirm` (use sparingly) |
| **Store fact** | `oracle memory add fact "name" "content"` |
| **List memory** | `oracle memory list` |
| **Search docs** | `oracle docs search "query"` |
| **Check setup** | `oracle doctor` |

---

## 🎯 Decision Tree

```
What do you need?
│
├─ Just read code → oracle ask
│
├─ Understand a problem → oracle agent --read-only
│
├─ Make small changes → oracle agent "task" --confirm
│
├─ Make important changes → oracle agent "task" --plan --review
│
├─ Complex multi-step work → oracle agent "task" --plan --review
│
└─ Store architectural decision → oracle memory add fact
```

---

## ⚠️ Safety Boundaries

**Always maintained:**
- ✅ Workspace confinement (no escaping with `../`)
- ✅ Secret scanning (detects and blocks API keys)
- ✅ .gitignore respect (doesn't expose ignored files)
- ✅ Audit trail (every action is logged)
- ✅ Step limits (default 20, max 50)

**When you enable mutations:**
- Only read-only by default
- Approval modes: `safe`, `careful`, `risky`
- Changes are checkpointed (resumable if interrupted)
- Test failures stop the agent

---

## 🔗 Related

- [Oracle Architecture](../../docs/architecture.md)
- [Oracle MCP Standards](../../docs/MCP-STANDARDS.md)
- [Runtime & Daemon](../../docs/runtime.md)
- [CLI Reference](../../docs/cli-reference.md)

---

**Remember:**
- `ask` = read-only
- `agent` = can do work
- `--plan` = safety first
- `--read-only` = investigate safe
- `memory` = persistent context
