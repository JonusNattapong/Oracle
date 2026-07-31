# Advisory panels

`oracle panel` puts one question to several backends at once and records what
came back in a **manifest**. It is for questions where a second opinion is the
point — an architectural call, a risky migration, a review where one model's
blind spot is another's strength.

## Asking

```bash
oracle panel ask "Should we migrate the session store to SQLite?" \
  --member anthropic \
  --member openai:gpt-4o \
  --member reviewer=gemini
```

Each `--member` is one seat:

| Spec | Seat id | Backend | Model |
| --- | --- | --- | --- |
| `anthropic` | `anthropic` | anthropic | backend default |
| `openai:gpt-4o` | `openai:gpt-4o` | openai | `gpt-4o` |
| `reviewer=gemini` | `reviewer` | gemini | backend default |
| `reviewer=openai:o1` | `reviewer` | openai | `o1` |

Seat ids must be unique. Two seats on the same backend are fine — give them
labels (`--member first=anthropic --member second=anthropic`) so the manifest
can tell them apart. A duplicate id is an error rather than a silent overwrite.

A member that names no model gets that backend's first real model. Backends
whose model is decided elsewhere — `codex` follows the local CLI's login,
`chatgpt-browser` follows the signed-in account — fall back to the project's
configured `model`.

Other options: `-f/--file` to include code (same globs as `oracle ask`),
`--soul` for a prompt persona, `--concurrency` (default 3), `--json`,
`--agent` for cost attribution.

## Partial success

A member that fails does not stop the others and does not fail the panel. This
is deliberate: you asked three advisors, two answered, and two answers are
useful. The manifest records exactly who answered and who did not.

```
Panel panel-20260731044703-efd8759d — 2 of 3 members answered; 1 failed.

## anthropic (anthropic:claude-opus-4-8)

Migrate. The session store's access pattern is already key-value…

## reviewer (gemini:gemini-2.0-flash)

Worth doing, but not before the retention policy is settled…

## Did not answer

- openai:gpt-4o (openai:gpt-4o): rate limited

Manifest: /work/.oracle/panels/panel-20260731044703-efd8759d.json
```

Every failure mode is captured per member: a missing credential, a rate limit, a
timeout, a thrown error. None of them can take the panel down.

### Exit codes

| Panel status | Meaning | Exit |
| --- | --- | --- |
| `complete` | Every member answered | 0 |
| `partial` | Some answered | 0, with a warning on stderr |
| `failed` | Nobody answered | 1 |

Pass `--require-all` when a partial result is not good enough — for example in
CI, where "one advisor was down" should stop the pipeline. It makes anything
short of `complete` exit 1.

## The manifest

Manifests are written to `.oracle/panels/<id>.json`:

```json
{
  "version": 1,
  "id": "panel-20260731044703-efd8759d",
  "createdAt": "2026-07-31T04:47:03.424Z",
  "status": "partial",
  "requested": 3,
  "succeeded": 2,
  "failed": 1,
  "members": [
    { "id": "anthropic", "backend": "anthropic", "status": "completed", "output": "…",
      "usage": { "inputTokens": 1200, "outputTokens": 380 }, "durationMs": 4120 },
    { "id": "openai:gpt-4o", "backend": "openai", "status": "error",
      "error": "rate limited", "durationMs": 210 }
  ]
}
```

Members appear in the order you declared them, not the order they finished, so
two runs of the same panel are diffable.

```bash
oracle panel list [--limit 20] [--json]
oracle panel show <id> [--json]
```

A manifest that fails to parse is skipped by `list` rather than breaking it.

## Cost

Each member is a separate call and is billed as one. A three-member panel over a
large file bundle costs roughly three times what `oracle ask` would. Members are
attributed individually, so `oracle usage by-agent` with `--agent` shows what a
panel actually cost.
