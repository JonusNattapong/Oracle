# Browser and provider parity

This repository keeps its v0.7 memory, agent, messaging, task, and runtime
architecture while delegating ChatGPT UI automation to the pinned
`@steipete/oracle@0.16.1` browser runtime.

## Implemented

- Browser provider with persistent manual login, attach-running, remote Chrome,
  remote service, model strategy, follow-ups, Deep Research, archive and
  attachment controls, and automatic reattach timing.
- Foreground `oracle serve` with safe project defaults, fixed or generated
  token, redacted command preview, and Ctrl+C lifecycle forwarding.
- Remote-service precedence: `--remote-host` suppresses incompatible local
  Chrome flags such as `--remote-chrome`, attach-running, and launcher options.
- Azure OpenAI and OpenRouter providers.
- Automatic routing for explicit browser/Azure prefixes, vendor-qualified
  OpenRouter model ids, Claude, GPT/o-series, and a configurable fallback.
- Shared project configuration used by CLI and MCP startup.
- `oracle bridge host|client|doctor` with owner-only SSH tunnel connection
  artifacts, token redaction, and ssh-option injection guards. See
  [Bridge](bridge.md).

## Remaining upstream work

- Multi-model advisory panels and partial-success manifests.
- Native browser artifact transfer metadata in Oracle's own session model.
