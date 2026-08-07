<p align="center">
  <img src="docs/assets/cover.png" alt="Oracle: AI-powered coding assistant with persistent memory and multi-agent coordination" width="100%" />
</p>

<h1 align="center">Oracle</h1>

<p align="center">
  <strong>Your personal AI coding consultant with long-term memory.</strong>
  <br />
  Ask questions, run autonomous agents, coordinate multiple AI assistants, and everything persists.
  <br />
  No context switching. No repeated explanations. Just continuous, contextual help.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jonusnattapong/oracle"><img src="https://img.shields.io/badge/npm-%40jonusnattapong%2Foracle-cb3837?style=flat-square" alt="npm" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D24-5fa04e?style=flat-square" alt="Node.js" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-server-7655e8?style=flat-square" alt="MCP" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-e9b44c?style=flat-square" alt="MIT" /></a>
</p>

---

## What is Oracle?

Oracle is a **workspace-aware AI assistant** that:
- **Remembers** your codebase, decisions, and context across sessions
- **Understands** your project structure, patterns, and constraints
- **Acts** autonomously with checkpointed loops and human oversight
- **Coordinates** multiple AI agents through messages, tasks, and consensus
- **Integrates** with ChatGPT Pro's Saved Memory for persistent cross-session learning

Think of it as a senior engineer who knows your codebase, remembers your constraints, and can execute complex tasks while keeping you in control.

---

## Quick Start (2 minutes)

### 1. Install

```bash
npm install -g @jonusnattapong/oracle
```

### 2. Verify Setup

```bash
oracle doctor
```

### 3. Ask Your First Question

```bash
oracle ask "Analyze the error handling in src/api --f "src/api/**/*.ts"
```

That's it. Oracle reads your files, respects your workspace, and gives you grounded answers.

---

## How It Works

### Option A: Interactive CLI

Perfect for humans who want to ask questions, explore code, and get immediate feedback.

```bash
# Ask a question
oracle ask "What's the bottleneck in the auth flow?" -f "src/auth/**/*.ts"

# Let it fix things (read-only mode first, then with approval)
oracle agent "Fix the flaky scheduler test" --plan --review

# View all your remembered context
oracle memory list
```

### Option B: Inside Your IDE (MCP)

Use Oracle as a tool inside Claude Code, Codex, or any MCP-compatible editor.

```bash
oracle setup-mcp --client claude-code
# Restart Claude Code → Oracle tools are available
```

Now your AI editor has:
- `oracle_ask` — grounded Q&A with memory
- `oracle_agent` — autonomous coding loops
- `oracle_memory_remember` — persistent facts
- `oracle_docs` — searchable knowledge base

### Option C: Long-Running Daemon

For scheduling, multi-agent coordination, and remote work.

```bash
oracle daemon start
oracle schedule add "nightly tests" "0 2 * * *" "npm test"
oracle control  # Opens the dashboard
```

---

## Five Key Features

### 1️⃣ Long-Term Memory (With ChatGPT Pro)

Oracle stores facts, decisions, and insights. With a ChatGPT Pro subscription, they sync to ChatGPT's Saved Memory.

```bash
# Enable hybrid memory (local + ChatGPT)
oracle memory store hybrid

# Oracle will remember:
# - Project architecture decisions
# - Common patterns in your code
# - Bug fixes and their context
# - Team conventions and constraints
```

Future conversations? Oracle retrieves the relevant context automatically.

### 2️⃣ Autonomous Agent with Checkpoints

Run complex tasks while staying in control. Oracle can:
- Read and explore your codebase
- Make changes (with approval gates)
- Run tests to verify work
- Checkpoint progress (resume if interrupted)

```bash
# Plan-first (safe)
oracle agent "Add input validation to all API handlers" --plan

# Then execute with review
oracle agent "Add input validation to all API handlers" --confirm
```

### 3️⃣ Multi-Agent Coordination

Connect multiple AI assistants through Oracle's message bus. They can:
- Send messages and coordinate work
- Verify tasks through checklists
- Reach consensus on decisions
- Scale across machines

```bash
# Agent A creates a task
oracle task create --title "Review auth changes" --assignee reviewer

# Agent B picks it up and completes it
oracle msg inbox --agent reviewer --wait
```

### 4️⃣ Image Generation & Analysis

Generate architecture diagrams, UI mockups, and more. Analyze screenshots and designs.

```bash
# Generate an image
oracle ask "Create a flowchart for the payment system" --model gpt-5.6-sol

# Analyze an image
oracle ask -f screenshot.png "Why is the mobile layout breaking?"
```

### 5️⃣ Grounded in Your Workspace

Unlike generic ChatGPT, Oracle:
- **Reads your actual files** (not summaries)
- **Respects .gitignore** and privacy
- **Compresses large files** to fit token limits
- **Scans for secrets** before sending code
- **Runs everything locally** (except the model)

```bash
# Oracle only sends selected files
oracle ask "Review auth logic" -f "src/auth/**/*.ts"

# It won't include node_modules, secrets, or random files
```

---

## Common Workflows

### Review Code with Real Context

```bash
oracle ask \
  "Find security issues and suggest fixes" \
  -f "src/api/**/*.ts" \
  --include-docs  # Also search .oracle/docs/
```

### Investigate Before Acting

```bash
# Read-only investigation (no changes)
oracle agent "Find and debug the memory leak" --read-only

# Once you understand it, fix it with approval
oracle agent "Fix the memory leak" --plan --approval-mode risky
```

### Generate Missing Tests

```bash
oracle agent \
  "Add unit tests for the payment handler. Target 90% coverage." \
  --review  # Auto-review the generated tests
```

### Scheduled Work

```bash
# Run focused tests every night
oracle schedule add \
  "nightly tests" \
  "0 2 * * *" \
  "npm test -- --coverage"

# View upcoming runs
oracle schedule list
```

---

## Memory: The Difference That Matters

### Without Memory
You ask the same questions repeatedly. Each conversation starts fresh. The AI gives similar answers but doesn't build on prior context.

### With Oracle's Memory
```bash
# First session
oracle ask "What's our database schema?"
# Oracle remembers this answer

# Days later, in a new session
oracle ask "Add a user_role field"
# Oracle recalls the schema, understands the constraints, gives better advice

# Weeks later
oracle memory list
# Shows 50+ facts, decisions, and architectural insights
```

The memory includes:
- **Facts** — project structure, API contracts, naming conventions
- **Insights** — lessons learned, performance gotchas, security constraints
- **Decisions** — "We chose PostgreSQL because..." (and why, not just what)
- **Links** — relationships between entities (services, users, databases)

---

## Who Should Use Oracle

### If You're a Solo Developer
Oracle is your on-demand senior engineer. It knows your codebase, remembers your constraints, and helps you move faster.

### If You're on a Team
Oracle coordinates work between human developers and AI assistants. Agents can work on different features simultaneously, passing context through shared memory.

### If You Have a Complex Codebase
Oracle's AST compression and entity graphs make sense of large projects. It finds connections you might miss.

### If You Use Claude, GPT, or Multiple Models
Oracle routes tasks to the right model and keeps context synchronized.

---

## Installation & Configuration

### Step 1: Install

```bash
npm install -g @jonusnattapong/oracle
oracle doctor  # Check that everything works
```

### Step 2: Pick Your Backend (Optional)

Oracle defaults to **ChatGPT Browser Mode** (no API key needed, uses your ChatGPT account).

Other options:
```bash
oracle models  # List available backends and models
oracle ask "..." --provider anthropic  # Use Claude
oracle ask "..." --provider openai     # Use GPT-4
```

### Step 3: Enable Memory (Optional)

If you have ChatGPT Pro:
```bash
oracle memory store hybrid  # Sync to ChatGPT's Saved Memory
```

Otherwise:
```bash
oracle memory store local   # Memory stays on your machine (default)
```

### Step 4: (Optional) Use in Your Editor

```bash
oracle setup-mcp --client claude-code
# Restart Claude Code
# Oracle tools now available in chat
```

---

## Commands at a Glance

```bash
# Ask questions
oracle ask "question" -f "src/**/*.ts"

# Run autonomous agents
oracle agent "task" --plan --review

# Manage memory
oracle memory list
oracle memory why <id> --for "your question"

# Manage docs & knowledge base
oracle docs add "decisions" docs/decisions.md
oracle docs search "how do we handle auth?"

# Coordinate agents
oracle task create --title "..." --assignee backend
oracle msg inbox --agent myself --wait

# Run scheduled tasks
oracle daemon start
oracle schedule add "tests" "0 2 * * *" "npm test"

# Debug
oracle doctor
oracle browser status
```

Full reference: `oracle --help` or see [CLI Docs](docs/cli-reference.md).

---

## Real-World Examples

### Example 1: Fixing a Bug You Don't Understand

```bash
# Investigate
oracle agent "Find the root cause of the scheduler timeout" --read-only

# Oracle explores the codebase, tests, git history, and returns a diagnosis

# Fix it
oracle agent "Fix the scheduler timeout based on the investigation" --plan --review

# Oracle shows the plan, you approve, it implements and tests
```

### Example 2: Scaling a Codebase

```bash
# Understanding current architecture
oracle ask "Map the dependency graph. What's tightly coupled?" \
  -f "src/**/*.ts" \
  --include-docs

# Oracle returns a visual breakdown of connections

# Planning refactoring
oracle agent \
  "Decouple the auth module from the user service" \
  --plan --review

# Running and verifying
oracle agent \
  "Decouple the auth module. Add tests. Verify no regressions." \
  --approval-mode careful
```

### Example 3: Onboarding a New Developer

```bash
# Create a knowledge base
oracle docs add "architecture" docs/architecture.md
oracle docs add "conventions" docs/conventions.md
oracle docs add "setup" docs/setup.md

# New developer asks
oracle ask "How do we structure API handlers?" --include-docs

# Oracle retrieves relevant docs + project memory + generates answer
```

---

## System Architecture

Oracle has **four entry points**, all backed by the same core engine:

| Entry Point | Use Case | Example |
|---|---|---|
| **CLI** (`oracle`) | Direct commands, interactive use | `oracle ask "..."` |
| **MCP Server** (`oracle-mcp`) | Integration with Claude Code, Codex, IDE extensions | Automated in-IDE tools |
| **Daemon** (`oracle-daemon`) | Long-running processes, scheduling, coordination | Scheduled tasks, multi-agent work |
| **Messaging Server** (`oracle-msg-mcp`) | Lightweight agent coordination | Message bus, tasks, consensus |

All share:
- The same **memory store** (SQLite locally, optional ChatGPT sync)
- The same **workspace boundary** (respects .gitignore, scans for secrets)
- The same **policy gates** (approval modes, step limits, audit trails)
- The same **session recording** (every interaction is logged and resumable)

---

## What Oracle Won't Do

- **Send your code to random APIs** — only to your configured backend
- **Make changes without approval** — agent loops can be read-only or require sign-off
- **Lose your context** — everything is persisted locally
- **Lock you into one model** — switch backends on a per-command basis
- **Hide what it's doing** — all sessions are recorded and inspectable

---

## Getting Help

- **First time?** Start with [Getting Started](docs/getting-started.md)
- **Want architecture details?** Read [Architecture](docs/architecture.md)
- **Need MCP integration?** See [MCP Standards](docs/MCP-STANDARDS.md)
- **Using ChatGPT Browser Mode?** Check [Browser Mode Docs](docs/browser-mode.md)
- **Troubleshooting?** [Troubleshooting Guide](docs/troubleshooting.md)

---

## Development

```bash
git clone https://github.com/OraclePersonal/Oracle.git
cd Oracle
npm install
npm run build && npm test
```

Before submitting a PR:
```bash
npm run verify       # Offline: build + lint + test
npm run verify:live  # Online: test against real ChatGPT (slow, real usage)
```

---

## License

MIT — Use freely, contribute openly.

---

## Built on Community

Oracle extends the original [steipete/oracle](https://github.com/steipete/oracle) prototype with persistent memory, multi-agent coordination, and a local control plane.

We stand on the shoulders of:
- **Model Context Protocol** — the standard for agent integration
- **Claude, GPT, Gemini** — the reasoning engines
- **ChatGPT Pro Saved Memory** — persistent context across sessions

---

**Ready to try it?**

```bash
npm install -g @jonusnattapong/oracle
oracle ask "Analyze this codebase and suggest improvements" -f "src/**/*.ts"
```

Your AI assistant that remembers. ✨
