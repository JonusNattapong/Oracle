---
title: ChatGPT Browser Mode
---

# ChatGPT Browser Mode

ChatGPT Browser Mode is the **primary default execution backend** in Oracle Ecosystems.
It sends Oracle's rendered prompt and file bundle through a visible Chrome session using
the user's manually authenticated ChatGPT account, requiring **zero API keys**.

This UI automation features a robust **W3C ARIA Accessibility Fallback Chain Engine**,
automated web model selection (e.g. `GPT-4o`, `o3-mini`, `Canvas`), and proactive
Cloudflare Turnstile challenge diagnostics.

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

### Composer tools

ChatGPT's composer offers tools behind the `+` button. Oracle can turn on Web
search for a single answer:

```bash
oracle ask --web-search "What changed in the Node LTS line this week?"
```

The menu opens only for trusted input, so Oracle drives it through the browser's
own event pipeline rather than `element.click()`, and the composer renders
several seconds after the page reports loaded — Oracle waits for the composer
itself instead of assuming a delay, because checking too early reports a tool as
off and switching it on again stacks a second pill into the message.

Selection is confirmed against the composer before the question is sent. If the
pill does not appear, the consult fails rather than answering as though the web
had been searched. The toggle applies to that one message: it is consumed when
the message is sent and does not linger on the account.

Note that ChatGPT also searches on its own when it judges a question needs it,
so omitting `--web-search` does not guarantee no search happened. What the flag
guarantees is that search was explicitly turned on and verified.

Deep research uses the same menu and needs two things the ordinary turn does
not:

```bash
oracle ask --deep-research "Research the current state of X. Keep it under 200 words."
```

- **A much larger budget.** The turn runs for many minutes, so the tool raises
  the timeout floor to 45 minutes rather than letting the three-minute default
  cut the research off partway.
- **No stall recovery.** Browser Mode reloads the page when a turn sits
  unchanged for ~30 seconds, which rescues a wedged UI. Deep research sits
  unchanged for minutes at a time by design, so that reload would throw the
  research away; it is disabled for this tool.

Deep research answers often embed charts. Oracle reports any it could not
capture as artifact warnings rather than dropping them silently.

`oracle browser stop` closes it. Browser Mode keeps Chrome running on purpose so
consecutive consults reuse one session, but that instance — profile plus any
extensions installed in it — holds real memory, which is worth reclaiming on a
constrained machine. The profile and its ChatGPT login stay on disk, so the next
consult simply starts a fresh instance; running it when nothing is up is a no-op.

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

### Checking for DOM drift

ChatGPT's DOM is not an API, and the composer menu carries no `data-testid` at
all — the handles there are a class name and the visible label. When the UI
changes, the affected feature fails at the moment someone runs it, with a
timeout that explains nothing.

```bash
oracle browser status --selectors
```

This resolves each handle against the live page and reports which alternate
matched. Falling through to a later fallback is drift that has already started,
even while everything still works. The check opens the composer menu to read it
and closes it again, so it never leaves a tool switched on.

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
- `accountMemorySaved: true` means the entry was found in the account after the
  write. ChatGPT's own success confirmation alone is **not** enough: it has been
  observed returning that confirmation for an entry the account never stored,
  because ChatGPT decides for itself what is worth remembering. Oracle therefore
  re-reads the account's own memory listing and only then reports success.
- `accountMemoryVerification` carries what is actually known:
  `verified` (checked and present), `unverified` (ChatGPT reported the save but
  the account could not be inspected — neither success nor failure), or
  `not-attempted`. A conclusive negative — the account is readable and does not
  contain the entry — raises `ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED`.
- The verification uses ChatGPT's internal memories endpoint from inside the
  authenticated page; the session token never leaves the browser. It is not a
  public API and may change, which is exactly why an unusable check degrades to
  `unverified` instead of being treated as either answer.

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
