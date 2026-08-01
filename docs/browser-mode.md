---
title: ChatGPT Browser Mode
---

# ChatGPT Browser Mode

ChatGPT Browser Mode is an experimental execution backend that sends Oracle's
rendered prompt and file bundle through a visible Chrome session. It uses the
ChatGPT account that the user logs into manually, so it does not require an API
key.

This is UI automation, not the OpenAI API. The ChatGPT DOM can change without
notice, structured token usage is unavailable, and the backend is intended for
interactive local use rather than unattended production workloads. Review the
service terms that apply to your account before enabling it.

## Configure

In `.oracle/config.json`:

```json
{
  "backend": "chatgpt-browser",
  "model": "gpt-5.4",
  "experimental": {
    "browserMode": true
  },
  "browser": {
    "timeoutMs": 180000
  }
}
```

`browser.profileDir` is optional. Relative paths resolve under `~/.oracle/`;
the default is `~/.oracle/chrome-profile`. Oracle always opens Browser Mode
headed and never exports the profile's cookies. By default Chrome chooses an
isolated debugging port and records its browser-specific endpoint inside that
profile. Fixed debugging ports are intentionally unsupported so Oracle cannot
silently attach to an unrelated Chrome instance.

## Set up and use

```bash
oracle browser setup
# Complete ChatGPT login in the Chrome window.

# If OAuth refuses the automation-enabled window:
oracle browser login
# Complete login, then close that Chrome window.

oracle browser status
oracle browser status --live # also verify the authenticated account session
oracle ask "Review this code" -f "src/**/*.ts" --backend chatgpt-browser
oracle ask "Describe this diagram" -f "docs/assets/system-map.png" --backend chatgpt-browser

# Reuse the same native ChatGPT conversation
oracle ask "Propose an architecture" --conversation architecture-1 --backend chatgpt-browser
oracle ask "Now challenge the weakest assumption" --conversation architecture-1 --backend chatgpt-browser

# Explicitly save one high-level preference to ChatGPT Saved Memory, then answer
oracle ask "Review this design" --remember "I prefer concise architecture reviews with explicit trade-offs" --backend chatgpt-browser
```

`oracle browser open` reopens the same isolated profile. Leave that Chrome
session open while running consults.

`oracle browser login` is a manual recovery flow. It closes only the verified
Chrome instance belonging to Oracle's isolated profile, then reopens that
profile without remote-debugging flags so OAuth providers do not classify the
login window as automated. Close the manual window after login; Browser Mode
will reopen the same persisted profile with automation enabled.

Oracle verifies that this isolated profile has an authenticated ChatGPT account
session before it sends a prompt. Guest mode is rejected because it cannot
persist native conversations and may not use the subscription/model the user
expects. Cookie values are never read or exported; the check uses only session
cookie names and visible account controls.

When `--conversation` is used, Oracle records the native ChatGPT conversation
URL as the session `responseId`. A later call with the same conversation id and
backend resumes that ChatGPT thread instead of opening a new one. Oracle only
accepts HTTPS conversation URLs on `chatgpt.com` (or the legacy
`chat.openai.com` host), and refuses redirects away from the saved thread.

## Reliability & Resilience (Self-Healing)

Browser Mode includes automated safeguards against web UI instability, network stalls, and Chrome DevTools Protocol (CDP) context drops:

- **CDP Execution-Context Retries**: When DOM mutations or page re-renders destroy the active JavaScript execution context (`Execution context was destroyed`, `Promise was collected`, or `Cannot find context`), Oracle catches the transient error and retries polling after a short 500ms backoff delay instead of failing immediately.
- **UI Stalling & Self-Healing Reload**: If ChatGPT stops streaming response tokens without showing the completion action controls (e.g. copy or feedback buttons) for 30 consecutive quiet polling intervals (~30 seconds), Oracle automatically triggers a self-healing page reload (`Page.reload`). Upon reload, it waits for the finalized turn to resolve.
- **No Partial Response Guarantee**: Oracle verifies that the assistant's turn is fully completed by asserting `hasCompletionAction`. If a response times out or stops streaming without exposing completion controls, Oracle explicitly rejects the turn and throws an error rather than returning a truncated or incomplete answer.
- **Multi-Turn Continuity Verification**: Continuous multi-turn conversations across 3+ sequential turns are validated by establishing a `ResponseBaseline` (tracking previous response counts and text) prior to prompt submission. This ensures that earlier turn outputs are never mistaken for the new response.
- **Frozen-Renderer Prevention**: Oracle's Chrome window is an automation surface nobody interacts with, so it spends its life minimized or fully covered — and Chrome freezes the renderers of backgrounded and occluded windows. A frozen renderer processes no page-domain CDP command, so the browser endpoint keeps answering while every `Runtime.evaluate` and `Page.enable` times out. Chrome is launched with `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`, and `--disable-features=CalculateNativeWinOcclusion`; a minimized window on an already-running instance (started by `oracle browser login`, an older version, or by hand) is restored before the page is driven.

If you do see repeated `CDP command ... timed out` errors, check whether the Oracle Chrome window is minimized, and restart it so the launch flags apply:

```bash
oracle browser status --live
```

## MCP

The `oracle_ask` tool accepts a per-call backend override:

```json
{
  "question": "Review this repository",
  "files": ["src/**/*.ts"],
  "backend": "chatgpt-browser",
  "conversationId": "architecture-1"
}
```

The MCP server still applies the normal file-size limits, secret scan, bundle
format, session recording, and workspace boundary.

### Image input and output

Browser Mode accepts PNG, JPEG, and WebP files through the normal `files`
field. Oracle validates the resolved real path against the workspace, checks
the declared MIME type against the file's magic bytes, and attaches the image
to ChatGPT's composer before sending the prompt:

```json
{
  "question": "Explain this architecture diagram",
  "files": ["docs/assets/system-map.png"],
  "backend": "chatgpt-browser"
}
```

Images generated or returned in the final assistant turn are fetched inside
the authenticated browser session, validated again, and saved under:

```text
~/.oracle/sessions/<session-id>/artifacts/images/output-001.png
```

The MCP result contains text first, followed by standard MCP `image` content
blocks (`data` base64 plus `mimeType`). `structuredContent.images` and Runtime
API session results contain the persisted `path`, `fileName`, `mimeType`,
`sizeBytes`, and optional `alt` text. CLI prints each saved path after the
answer. Capture failures that do not invalidate the textual answer are reported
in `artifactWarnings`.

Image safety limits:

- PNG, JPEG, and WebP only; extension/MIME spoofing is rejected.
- Existing `maxFileSizeBytes` and `maxInputBytes` configuration applies to
  selected input files, with an additional hard limit of 10 MiB per Browser
  Mode image.
- At most 8 output images, 10 MiB each, and 25 MiB total per response.
- Input symlinks resolving outside the workspace are rejected. Output names
  are generated by Oracle and real paths are checked against the session
  artifact directory before they are recorded or returned through MCP.
- Oracle performs no Node-side fetch of assistant-provided URLs. Image bytes
  are captured within the ChatGPT page, avoiding arbitrary URL fetching and
  preventing signed asset URLs from being persisted.

### ChatGPT account memory

`oracle_ask` can explicitly save a high-level fact or preference to the
authenticated ChatGPT account before answering:

```json
{
  "question": "Review this repository",
  "backend": "chatgpt-browser",
  "accountMemory": "I prefer concise reviews with concrete file references"
}
```

This is opt-in per call. Oracle opens a separate fresh ChatGPT chat for the
memory command, requires the exact `ORACLE_MEMORY_SAVED` confirmation, then
returns to the requested conversation and sends the normal question. The
memory text is passed separately from the project bundle and is not written to
Oracle's `bundle.md` or `session.json`; the session stores only
`accountMemoryRequested` and `accountMemorySaved`. Oracle applies its secret
detectors to the memory text before opening ChatGPT.

Account memory is different from Oracle project memory:

- ChatGPT Saved Memory belongs to the signed-in ChatGPT account and may affect
  future chats outside Oracle.
- Use it for short preferences or durable facts, not secrets, credentials,
  exact templates, source code, or large text. Oracle limits the value to 2,000
  characters.
- ChatGPT Memory must be enabled under **Settings > Personalization**. A
  Temporary Chat cannot create or use saved memories.
- Deleting the memory-command chat does not delete the saved memory. To remove
  it, tell ChatGPT to forget it or use **Settings > Personalization > Manage
  memories**. Consult ChatGPT's account UI for the authoritative stored list.
- `accountMemorySaved: true` means ChatGPT returned the required success
  confirmation. Browser Mode does not scrape the Manage Memories settings
  screen for a second independent verification.

### Saved Memory as Oracle's memory store

The per-call `accountMemory` above writes one fact and is unrelated to where
Oracle keeps its own memory. To make Saved Memory the store itself, set
`memory.store` to `chatgpt` (account-only) or `hybrid` (local canonical plus a
mirror of high-importance entries):

```bash
oracle memory store hybrid
```

Both modes drive this backend, so they inherit every limitation on this page —
manual login, an isolated Chrome profile, and UI automation rather than an API.
Saved Memory also has no ids, tags, importance, or timestamps, caps entries at
2,000 characters, and can only be read back through a natural-language
round-trip, so completeness and ordering are best-effort. See
[Memory store](config-schema.md#memory-store) for the full trade-offs.

## Runtime API

The authenticated local Runtime API exposes the same consult service:

```http
POST /v1/consult
Authorization: Bearer <runtime-token>
Content-Type: application/json

{
  "question": "Explain the scheduler diagram",
  "files": ["docs/assets/scheduler.png"],
  "backend": "chatgpt-browser",
  "conversationId": "scheduler-review-1",
  "accountMemory": "I prefer scheduler explanations as short event timelines"
}
```

Retrieve a recorded result with `GET /v1/consult/:sessionId`. Any supplied
`cwd` must remain within the daemon's configured workspace root.

## Limitations

- Text consults, PNG/JPEG/WebP upload, assistant-image persistence, native
  conversation continuation, and explicit ChatGPT account memory writes are
  supported. Agent tool use is not supported.
- A desktop GUI session and Google Chrome are required.
- Login, CAPTCHA, consent, and account recovery remain manual.
- Live ChatGPT automation is not run in CI. Tests use deterministic fake
  backends and CDP fixtures.
- Codex CLI remains the recommended default for unattended or portable use.
