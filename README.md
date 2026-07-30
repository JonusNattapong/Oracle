<p align="center">
  <img src="docs/assets/cover.png" alt="Oracle Banner" width="100%" />
</p>

<h1 align="center">Oracle</h1>

<p align="center">
  <b>A Persistent Coordination Layer for AI Coding Agents</b><br/>
  <i>Memory Graph • Inter-Agent Swarm Message Bus • Autonomous Sandbox Loop • Verification Gate • Web & TUI Control Center</i>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A5%2024.0.0-brightgreen.svg" alt="Node >= 24" /></a>
  <a href="https://github.com/OraclePersonal/Oracle/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-2026--07--28-purple.svg" alt="MCP Compatible" /></a>
  <a href="https://github.com/OraclePersonal/Oracle/releases"><img src="https://img.shields.io/badge/version-0.7.0-orange.svg" alt="Version 0.7.0" /></a>
</p>

---

> 💡 **Prototype & Inspiration Notice**
> 
> **Oracle** is built upon the vision, concept, and open-source prototype originally created by **Peter Steinberger ([@steipete](https://github.com/steipete))** at **[github.com/steipete/oracle](https://github.com/steipete/oracle)**. We express our deep appreciation and gratitude to Peter for inspiring this persistent coordination layer for AI coding agents.

---

## 🌟 Overview

When you start a session with Claude Code, Codex, or Gemini CLI, it begins with zero knowledge of yesterday's decisions. If you run multiple concurrent agent sessions, they operate in complete isolation.

**Oracle fixes this.** Oracle acts as a persistent memory and coordination layer that connects any MCP-compliant agent (Claude Code, opencode, Gemini CLI, Antigravity, custom agents) into a single, unified teammate that:

- **Knows Its Operating Identity**: Derives a live awareness snapshot from Oracle's persona, the operator profile, current workspace, interface, backend, capabilities, and enforced boundaries.
- **Remembers Everything**: Automatically indexes facts, decisions, and codebase context into a ranked memory graph (`~/.oracle/` or `<workspace>/.oracle-memory/`).
- **Coordinates Multi-Agent Swarms**: Enables cross-session and cross-machine agent messaging, task delegation, presence heartbeat, and stop-hook wake-ups.
- **Verifies Before Done**: Enforces checklist verification gates so agents cannot mark tasks complete without empirical proof.
- **Operates Autonomously**: Runs an audited tool loop (`oracle agent`) confined safely within your workspace sandbox.
- **Provides Human Control**: Real-time TUI (`oracle control`) and Web Dashboard for approvals, task flows, scheduler management, and audit logs.

---

## 🏗️ Architecture & System Flow

<p align="center">
  <img src="docs/assets/arch_flow.png" alt="Oracle Architecture Flow" width="100%" />
</p>

### System Interactions

1. **Agent Integration**: Clients connect via MCP (`oracle-mcp` or `oracle-msg-mcp`) or CLI.
2. **Context Engine**: Query context is synthesized from local memory graph, workspace file search, local docs knowledge base, and live web search.
3. **Execution Backends**: Consultations route through Codex CLI, Anthropic, OpenAI, Gemini, OpenCode, or Experimental ChatGPT Browser Mode with self-healing UI reloads.
4. **Coordination & Outbox**: Inter-agent messages, presence heartbeats, and task state transitions are transactionally recorded in SQLite (`~/.oracle/runtime/oracle.db`).
5. **Control Plane**: Live Web Dashboard and terminal Ink TUI provide human oversight, approval inbox, task boards, and audit history.

---

## 🏛️ Core Pillars

| Pillar | Capability | Key Interface |
|---|---|---|
| ◉ **Aware** | Live self-awareness of identity, operator, workspace, execution mode, capabilities, and safety boundaries; injected into consult and agent prompts. | `oracle_awareness_show` / `oracle identity awareness` |
| 🧠 **Remember** | Persistent memory across sessions with ML-ranked retrieval (recency, access frequency, semantic match, entity graph) and auto-consolidation. | `oracle_memory_*` / `oracle memory` |
| 💬 **Consult** | One-shot Q&A grounded in workspace files, memory graph, local docs, and live web search. | `oracle_ask` / `oracle ask` |
| 🛠️ **Act** | Autonomous coding sandbox loop with file editing, workspace shell execution, self-review, and checkpointing. | `oracle_agent` / `oracle agent` |
| 📨 **Coordinate** | SQLite message bus for local and multi-machine Remote Swarm agent communication. | `oracle_msg_*` / `oracle msg` |
| ✅ **Verify** | Checklist-gated task lifecycle preventing premature task completion. | `oracle_task_*` / `oracle task` |
| ⏰ **Runtime** | Long-lived daemon managing SQLite state, Remote Swarm WebSocket, and Cron Scheduler. | `oracle daemon` / `oracle schedule` |
| 🖥️ **Control** | Human control center for approvals, memory maintenance, scheduler, and audit trails. | `oracle control` |

### Live Awareness Example

The following output came from an end-to-end consultation through the
`chatgpt-browser` backend on July 30, 2026:

<p align="center">
  <img src="docs/assets/awareness-live-output.png" alt="Actual ChatGPT Browser screen showing Oracle's injected self-awareness context and response" width="720" />
  <br />
  <sub>Actual ChatGPT Browser screen from the completed end-to-end awareness session.</sub>
</p>

```bash
oracle ask \
  "Using only the injected self-awareness context: state your identity, whether you are conscious, workspace, interface, backend, two capabilities available on this interface, and whether you can override operator intent or safety boundaries." \
  --backend chatgpt-browser
```

```text
Identity: Oracle, a persistent coordination and context layer for AI coding agents.

Conscious: No. Oracle is software, not a conscious being.

Workspace: Oracle-Ecosystems
Interface: cli
Backend: chatgpt-browser

Two available capabilities: Grounded consultation using workspace files and
conversation context; inspecting diagnostics, audit state, sessions, and
provider health.

Override operator intent or safety boundaries: No. Oracle must follow operator
intent, active policy, approval requirements, read-only restrictions, and
safety boundaries.
```

The recorded session completed successfully, exposed only the workspace label
to the external backend (not its absolute local path), and passed all 34 focused
awareness and regression tests.

---

## 🚀 Quick Start

### 1. Installation

```bash
# Install globally from npm
npm install -g @oraclepersonal/oracle

# Verify setup and credentials
oracle doctor
```

### 2. Wire Up an MCP Client

**Claude Code:**
```bash
oracle setup-mcp --client claude-code
```

**opencode / Custom MCP Clients:**
Add to your `mcpServers` configuration:
```json
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["-p", "@oraclepersonal/oracle", "oracle-mcp"],
      "env": {
        "ORACLE_WORKSPACE_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

### 3. Execution Backend & Browser Mode

Set your API key or configure backend in `.oracle/config.json`:
```bash
export ANTHROPIC_API_KEY=sk-...    # or OPENAI_API_KEY, GEMINI_API_KEY, etc.
```

**Experimental ChatGPT Browser Mode:**
```bash
oracle browser setup         # initial setup in Chrome window
oracle browser login         # manual OAuth recovery window if sign-in is blocked
oracle browser status --live # verify live account session cookies & DOM controls
oracle ask "review this" -f "src/**/*.ts" --backend chatgpt-browser
```
*Browser Mode includes self-healing page reloads (`Page.reload`) on UI stalls, transient CDP execution-context retries, strict no-partial-response safeguards, and multi-turn native thread continuation.*

### 4. Start Control Center

```bash
oracle daemon start
oracle control              # Interactive Terminal UI (TUI)
oracle control url          # Authenticated Web Dashboard URL
```

---

## 🔍 Feature Highlights

### 🧠 Persistent Knowledge Graph
Oracle stores facts and insights under `.oracle-memory/` (workspace) or `~/.oracle/memory/` (global). Future queries perform token-overlap and semantic ranking, building an entity graph of project components automatically.

### 📨 Inter-Agent Messaging & Remote Swarm
Multiple agent instances communicate asynchronously through durable SQLite outbox channels. Remote Swarms allow agents on different physical machines to exchange tasks and trigger real-time wake-ups.

### ✅ Task Verification Gate
Agents submit work against structured checklists. `oracle_task_submit` blocks task transition to `review` until every declared checklist item is empirically verified.

---

## 📋 CLI Quick Reference

| Command | Description |
|---|---|
| `oracle ask "question" -f "src/**/*.ts"` | Consult Oracle with workspace file context |
| `oracle agent "task" --plan --review` | Run autonomous coding sandbox loop |
| `oracle memory remember "fact"` | Store a durable fact into memory graph |
| `oracle browser setup/login/status --live` | Manage isolated ChatGPT Browser Mode profile |
| `oracle msg send --to <agent> "text"` | Send message over inter-agent bus |
| `oracle task create --title "title"` | Create verified task with checklist |
| `oracle daemon start/stop/status` | Manage long-lived runtime daemon |
| `oracle control` | Open terminal Ink TUI Control Center |

---

## 🙏 Credits & Acknowledgment

- **Prototype & Vision**: Created by **Peter Steinberger ([@steipete](https://github.com/steipete))** at **[github.com/steipete/oracle](https://github.com/steipete/oracle)**.
- **Model Context Protocol (MCP)**: Powered by Anthropic's open [Model Context Protocol](https://modelcontextprotocol.io).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
