# Install oracle-agent-guide

**Comprehensive guide for AI agents using Oracle CLI and MCP.**

---

## Requirements

The Claude Code and Codex plugins run Node.js lifecycle hooks, so `node` needs to be on your PATH (note for Nix/nvm users: it must be on the non-interactive shell's PATH). If it isn't, the skills still work, the always-on activation just stays quiet instead of erroring on every prompt.

---

## Claude Code

```bash
/plugin marketplace add OraclePersonal/oracle-ecosystems
```

Then:

```bash
/plugin install oracle-agent-guide@OraclePersonal/oracle-ecosystems
```

(You have to send two separate prompts for the install to work)

Same steps in the Claude Code Desktop app's Code tab: type the two `/plugin` commands above into the prompt box, or click the `+` button next to it, choose **Plugins → Add plugin** to browse your configured marketplaces, and manage marketplaces from **Customize** in the sidebar.

---

## Codex

```bash
codex plugin marketplace add OraclePersonal/oracle-ecosystems
codex plugin add oracle-agent-guide@OraclePersonal/oracle-ecosystems
```

Run `codex` and open `/hooks`, review and trust its two lifecycle hooks, and start a new thread.

---

## Manual Installation

If marketplace isn't available, manually copy the plugin:

### Claude Code

1. Create `.claude/plugins/oracle-agent-guide/`
2. Copy `ORACLE_AGENT_INSTRUCTIONS.md` → `plugin.json` (as system prompt)
3. Restart Claude Code
4. Plugin loads automatically

### Codex

1. Create `.codex/plugins/oracle-agent-guide/`
2. Copy plugin files
3. Run `codex plugin add oracle-agent-guide`
4. Restart Codex

---

## Verify Installation

After install, test:

```bash
oracle_ask "How should I use Oracle agent correctly?"

# Expected response mentions:
# ✅ Use oracle_ask for read-only
# ✅ Use oracle_agent --plan for mutations
# ✅ Store only safe facts in memory
# ✅ Run tests to verify changes
```

If agent mentions these patterns, plugin is loaded! ✨

---

## What It Does

Once installed, the plugin ensures your agents:
- ✅ Use `oracle_ask` for read-only operations
- ✅ Use `oracle_agent --plan` for important changes
- ✅ Store only safe facts in memory
- ✅ Verify tests after changes
- ✅ Follow safety boundaries

---

## Troubleshooting

### Plugin not loading

Check:
```bash
# Verify oracle-agent-guide exists
ls ~/.claude/plugins/oracle-agent-guide/

# Check plugin.json
cat ~/.claude/plugins/oracle-agent-guide/plugin.json
```

### Agent not following patterns

Verify system prompt is loaded:
```bash
# Agent should mention in first response:
# "I'll use oracle_ask for read-only..."
# "I'll use oracle_agent --plan before changes..."
```

If not mentioned, plugin may not be active.

---

## Documentation

- **ORACLE_USAGE_GUIDE.md** — Complete guide
- **ORACLE_AGENT_INSTRUCTIONS.md** — System prompt content
- **plugin.json** — Metadata

---

**Ready to guide your agents safely.** 🚀
