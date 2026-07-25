# Oracle Configuration Schema

`.oracle/config.json` defines Oracle's runtime behavior per project.

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
