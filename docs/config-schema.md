# Oracle Configuration Schema

`.oracle/config.json` defines Oracle's runtime behavior per project.

## v0.7.0 additions

### Execution backend

`backend` selects the model transport. The former `provider` key remains
accepted for compatibility and is normalized at load time.

```jsonc
{
  "backend": "codex",
  "model": "gpt-5.4",
  "experimental": {
    "browserMode": false
  },
  "browser": {
    "profileDir": "chrome-profile",
    "timeoutMs": 180000
  }
}
```

Browser paths relative to `~/.oracle/` keep login state outside the project.
See [browser-mode.md](browser-mode.md).

### Memory store

`memory.store` selects where durable memory lives. The default keeps everything
on this machine.

```jsonc
{
  "memory": {
    // "local" (default) | "chatgpt" | "hybrid"
    "store": "hybrid",
    // Backend used to reach ChatGPT Saved Memory. Only value today.
    "remoteBackend": "chatgpt-browser",
    // Reuse window for a Saved Memory read, in minutes. 0 disables caching.
    "remoteCacheTtlMinutes": 10,
    // hybrid only: which local entries are also pushed to the account.
    "mirror": {
      "minImportance": 0.7,
      "types": ["fact", "insight"],
      "tags": ["shared"]          // optional allow-list
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `store` | `"local"` | `local` = this machine only; `chatgpt` = the signed-in account's Saved Memory is the store; `hybrid` = local canonical plus a mirror |
| `remoteBackend` | `"chatgpt-browser"` | Backend driving the signed-in session |
| `remoteCacheTtlMinutes` | `10` | How long a Saved Memory read is reused (0–1440) |
| `mirror.minImportance` | `0.7` | Minimum importance (0–1) for an entry to be mirrored |
| `mirror.types` | `["fact","insight"]` | Memory types eligible for mirroring |
| `mirror.tags` | unset | When set, an entry must also carry one of these tags |

Switch stores from the CLI:

```bash
oracle memory store              # show current setting
oracle memory store hybrid       # write it to .oracle/config.json
```

`chatgpt` and `hybrid` require a signed-in ChatGPT session and inherit every
[Browser Mode](browser-mode.md) limitation. When the backend is unavailable or
cannot write account memory, Oracle logs the reason and falls back to local
memory rather than dropping writes.

Saved Memory is a weaker store than the local one:

- No ids, tags, importance, or timestamps — Oracle keeps those in a local shadow
  index and joins them to the remote text by content hash.
- 2000 characters per entry. Larger writes are rejected in `chatgpt` mode and
  skipped by the mirror in `hybrid` mode.
- Reads are a natural-language round-trip, so ordering and completeness are
  best-effort; an unreadable account raises an error rather than reporting an
  empty memory.
- Writes and deletes count only when ChatGPT confirms them.
- `working` memory never leaves the machine.
- In `hybrid` mode, `forget` removes the local copy only; the mirrored entry
  stays in the account until deleted from ChatGPT settings → Personalization →
  Manage memory.

Entity graph, consolidation, decay, and reflection are local-only in every mode.

### Backend credentials

| Backend | Environment variable | Notes |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_API_BASE` to redirect |
| Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `GEMINI_API_BASE` to redirect |
| OpenCode | `OPENCODE_API_KEY` | any OpenAI-compatible endpoint |
| Codex | — | uses local CLI login state |
| ChatGPT Browser | — | manual login in an isolated Chrome profile; experimental |

`oracle models` lists every model and which providers have credentials.

### Cost accounting

Spend is recorded automatically for every consult:

```bash
oracle usage                 # today
oracle usage week --agent planner
oracle usage budget 25 -w month
oracle usage prune --days 90
```

Cost is derived from a built-in price table. Local providers (Ollama) are
free; a model absent from the table reports `$0` and says so, rather than
inventing a price. Attribute a call with `oracle ask --agent <name>`.

### Execution sandbox policy

Set sandboxing in the workspace's `.oracle/policy.json` (not
`.oracle/config.json`):

```jsonc
{
  "sandbox": {
    "mode": "docker", // "docker" | "none"; default "none"
    "image": "node:24-bookworm-slim",
    "network": "none", // required in the current Docker sandbox
    "memoryMb": 512,
    "cpuCount": 1,
    "pidsLimit": 128,
    "environment": ["NODE_OPTIONS"]
  }
}
```

Docker mode is fail-closed: naming it when Docker or its image is unavailable
stops the command rather than running it on the host. Run `oracle sandbox
doctor` to inspect the effective boundary. See [Execution sandbox](sandbox.md)
for security properties and limits.

### Memory graph

```bash
oracle memory graph show --limit 20 --connected
oracle memory graph entity Redis
oracle memory graph path Oracle Docker
```

## Schema v1.0

```jsonc
{
  "version": "1.0",
  
  // Embedding provider configuration (v0.6.0+)
  "memory": {
    "embeddingProvider": "ollama", // "ollama" | "voyage" | "openai" | "gemini"
    
    // Optional: override detected provider
    "embeddingProviderApiKey": null,  // Set if using external provider
    
    // Search tuning
    "hybridSearchK": 60,  // RRF fusion parameter (lower = rank matters more)
    "bm25Only": false,     // Force lexical-only search (debug)
  },
  
  // Storage locations (v0.1+)
  "storage": {
    "memoryPath": ".oracle-memory",
    "databasePath": "~/.oracle/runtime/oracle.db"
  },
  
  // Runtime daemon (v0.2+)
  "runtime": {
    "port": 6379,
    "host": "127.0.0.1",
    "enableWebSocket": true,
    "logLevel": "info"  // "debug" | "info" | "warn" | "error"
  },
  
  // Remote swarm configuration (v0.5+)
  "remoteSwarm": {
    "enabled": false,
    "tokenTTLSeconds": 86400,  // 24 hours
    "requireTLS": true
  }
}
```

## Environment Variables (Overrides)

Embedding provider detection (tried in order):

1. `OLLAMA_ENDPOINT` (default: `http://localhost:11434`) — local Ollama
2. `VOYAGE_API_KEY` — Voyage AI
3. `OPENAI_API_KEY` — OpenAI
4. `GEMINI_API_KEY` — Google Gemini

If none set, memory falls back to BM25-only (lexical search, no semantic).

## Migration Notes

### v0.5 → v0.6

- `config.json` gains `memory` section with `embeddingProvider`
- Existing `vectors.json` auto-migrates to SQLite schema v7 on first daemon startup
- No action required; fully backwards compatible

### Rollback

To disable hybrid retrieval:
```json
{ "memory": { "bm25Only": true } }
```

Falls back to lexical search immediately (no vector computation).

## Example: Using Voyage AI

```bash
export VOYAGE_API_KEY="your-key"
# oracle init or oracle daemon — will auto-detect Voyage
```

Verify with:
```bash
oracle memory status
# Output: embedding-provider: voyage, vectors: 1250, content: 1250
```

## Example: Docker with OpenAI

```dockerfile
ENV OPENAI_API_KEY=sk-...
# oracle will auto-detect OpenAI
```

## Debugging

Show current configuration:
```bash
oracle config show
```

Show memory/embedding status:
```bash
oracle memory status
```

Show vector store statistics:
```bash
oracle memory stats
```
