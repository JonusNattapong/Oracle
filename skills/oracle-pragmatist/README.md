# Oracle Usage Guide Plugin

**Ensure AI agents use Oracle CLI and MCP correctly.**

This plugin provides comprehensive guidance for AI agents (and humans) to use Oracle safely and effectively. It covers:
- ✅ When to use oracle ask vs oracle agent
- ✅ Safety patterns (read-only first, plan before changes)
- ✅ Memory best practices
- ✅ Common mistakes and how to avoid them
- ✅ Command patterns and workflows

---

## What This Is

This is a **guide plugin**, not a skill that changes Oracle's behavior. It's documentation that helps AI agents understand Oracle's capabilities and limitations.

Think of it as a manual for agents. When an agent uses Oracle, it should follow these patterns.

---

## Documentation Files

### 1. **ORACLE_USAGE_GUIDE.md** ← Start here

Comprehensive guide covering:
- Core workflows (ask, investigate, plan, execute)
- Memory best practices
- MCP tool usage
- Common mistakes
- Safety boundaries
- Decision tree

**For:** Agents deciding how to use Oracle

### 2. **ORACLE_AGENT_INSTRUCTIONS.md** ← Load as system prompt

Instructions for AI agents using Oracle, covering:
- Golden rules (read-only first, plan before mutations)
- Command patterns
- Things to never do
- Safety checklist
- Verification steps

**For:** Inject into agent system prompts

### 3. **PRAGMATIST.md** ← Philosophy guide

Pragmatism philosophy (optional):
- Reuse first, build second
- YAGNI principle
- Minimize dependencies
- Examples and anti-patterns

**For:** Agents wanting to minimize over-engineering

---

## How to Use

### Option 1: Human Developers

Read the guides:
```bash
# Quick reference
cat skills/oracle-pragmatist/ORACLE_USAGE_GUIDE.md

# Full instructions for agents
cat skills/oracle-pragmatist/ORACLE_AGENT_INSTRUCTIONS.md
```

### Option 2: AI Agents (MCP)

Load as system prompt:
```bash
# This guide should be included in system context
# when oracle_agent or oracle_ask is called
```

### Option 3: Inside Claude Code

Enable via MCP:
```bash
oracle setup-mcp --client claude-code
# Claude Code loads ORACLE_AGENT_INSTRUCTIONS automatically
```

---

## Golden Rules Summary

### 1. Read-Only First
```bash
# Investigate safely
oracle_agent { prompt: "...", read_only: true }

# Then act
oracle_agent { prompt: "...", mode: "plan" }
```

### 2. Plan Before Important Changes
```bash
# See what will happen
oracle_agent { prompt: "...", mode: "plan" }

# Then execute
oracle_agent { prompt: "...", confirm: true }
```

### 3. Only Store Safe Facts in Memory
```bash
# ✅ Good: Store architectural decisions
oracle_memory_remember { type: "fact", content: "We use PostgreSQL" }

# ❌ Wrong: Don't store secrets
oracle_memory_remember { type: "fact", content: "API_KEY=..." }
```

### 4. Scope Tasks Clearly
```bash
# ❌ Too broad
oracle_agent { prompt: "Refactor everything" }

# ✅ Specific
oracle_agent { prompt: "Add validation to user endpoint" }
```

### 5. Always Verify
```bash
# After changes
npm test
npm run typecheck
git diff  # Review changes
```

---

## Command Patterns

| Goal | Pattern |
|------|---------|
| **Answer a question** | `oracle_ask { include_docs, include_memory }` |
| **Investigate (safe)** | `oracle_agent { read_only: true }` |
| **Plan changes** | `oracle_agent { mode: "plan" }` |
| **Execute (safe)** | `oracle_agent { mode: "plan" } → confirm` |
| **Store knowledge** | `oracle_memory_remember { type: "fact" }` |
| **Search docs** | `oracle_docs_search { query }` |

---

## Common Mistakes

### ❌ Don't: Use ask for mutations
```bash
oracle_ask "Refactor the module"  # Wrong, ask is read-only
```
### ✅ Do: Use agent with plan
```bash
oracle_agent { prompt: "Refactor the module", mode: "plan" }
```

---

### ❌ Don't: Skip planning for important changes
```bash
oracle_agent { prompt: "Change auth system", confirm: true }  # Risky!
```
### ✅ Do: Plan first
```bash
oracle_agent { prompt: "Change auth system", mode: "plan" }
# Review → then confirm
```

---

### ❌ Don't: Store secrets
```bash
oracle_memory_remember { content: "AWS_KEY=AKIA..." }  # Never!
```
### ✅ Do: Store only safe facts
```bash
oracle_memory_remember { 
  content: "We use AWS RDS PostgreSQL 15"  // Safe
}
```

---

## When Each Tool Is Right

```
oracle_ask
├─ "How does auth work?" → YES
├─ "Refactor this" → NO
├─ "Find the bug" → YES
└─ "Fix the bug" → NO (use agent)

oracle_agent (read_only)
├─ "Diagnose the issue" → YES
├─ "Explain the pattern" → YES
├─ "Propose a solution" → YES
└─ "Implement it" → NO (use mode: plan)

oracle_agent (with mutations)
├─ "Add validation" → YES (plan first)
├─ "Fix typo" → YES (can confirm directly)
├─ "Change schema" → YES (plan first!)
└─ "Rewrite everything" → NO (too broad)

oracle_memory
├─ "Remember this pattern" → YES
├─ "Store this API key" → NO
├─ "Remember our decision" → YES
└─ "Store temp state" → NO (use working memory)
```

---

## Safety Checklist

Before running mutations, an agent should verify:
- [ ] I understand what I'm changing
- [ ] I know why I'm changing it
- [ ] Tests will verify it works
- [ ] I can explain the change in a code review
- [ ] The change is focused (one feature, not refactoring)
- [ ] I've used --plan for important changes

---

## For Oracle Developers

This plugin is designed to:
1. **Document** how agents should use Oracle
2. **Prevent** common mistakes
3. **Guide** agents toward safe patterns
4. **Enable** confidence in agent-driven changes

The rules encode Oracle's safety model:
- Workspace confinement ✅
- Secret scanning ✅
- Audit trails ✅
- Approval gates ✅
- Read-only mode ✅

---

## Related

- [Oracle Architecture](../../docs/architecture.md)
- [Oracle MCP Standards](../../docs/MCP-STANDARDS.md)
- [Oracle CLI Reference](../../docs/cli-reference.md)
- [Pragmatism Philosophy](./PRAGMATIST.md)

---

**Load this plugin in your agent system prompts to ensure correct Oracle usage.**
