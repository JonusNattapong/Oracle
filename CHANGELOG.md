# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **Agent file tools could be walked out of the workspace by a link.**
  `resolveInWorkspace()` resolved paths lexically, which normalises `../` but
  says nothing about what a link points at: a symlink or directory junction
  inside the workspace resolves to a path inside the workspace, and the kernel
  then follows it out. `read_file`, `write_file`, `edit_file`, and `list_dir`
  all went through it, so the agent could read and write outside the workspace
  root — including under `--read-only`, which drops the mutating tools but
  keeps `read_file`. Git records links in a tree, so cloning a repository was
  enough to place one. `glob` and `grep` also descended links, reporting paths
  outside the workspace as workspace contents.

  Containment is now checked on the canonical path, with the not-yet-existing
  tail of a `write_file` target resolved against its nearest existing ancestor.
  Directory traversal skips links and re-checks containment per directory, so
  it does not depend on how a given OS reports one. The consult path
  (`src/context/files.ts`) already resolved through `fs.realpath` and was not
  affected.

  Regression tests cover read, write, list, glob, and grep through a directory
  link; all five failed before the fix.

### Changed
- **The store's directories are created once per adapter, not once per write.**
  A CPU profile of 300 sequential writes put `mkdir` above everything else
  Oracle was doing: `ensureDirs()` ran five recursive `mkdir` calls at the top
  of every `remember()` and again inside every queued index append. 100 writes
  issued 1006 `mkdir` calls before, 6 after. Writes retry once against a
  rebuilt store if it disappears underneath a live adapter, so the memo stays
  an optimisation rather than an assumption.

## [0.8.2] - 2026-08-07

### Added
- **Supersession — memory can say a fact stopped being true.**
  `oracle_memory_remember` takes `supersedes: [id, ...]`, and the named entries
  stop surfacing in recall and search instead of competing with the new one as
  equally current. Previously "we use PostgreSQL" and "we migrated to MySQL"
  were both live, both recalled, and the model had to guess which was current
  from two entries that each read as settled. The replaced entry stays on disk
  with a `supersededBy` pointer and the winner records `supersedes`, so the
  decision history stays walkable — `includeArchived` brings the whole chain
  back. Unknown ids are ignored rather than failing the write.

  Supersession is asserted by the writer, never inferred. Which of two settled
  statements came second is a reading of meaning, and guessing at it from term
  overlap would retire correct memories on a coincidence of vocabulary.

### Changed
- **Writes no longer cost O(store size).** Two independent full-store passes ran
  on every `remember()`: duplicate detection scanned the whole type directory,
  and entity-graph indexing rewrote `graph.json` in full. Seeding a store was
  quadratic — 250 sequential writes into a 250-entry store took ~54s. Duplicate
  detection now goes through an append-only content index (the same NDJSON shape
  as the anchor index), and graph saves on the hot path are debounced and
  coalesced. Measured on 500 sequential writes: ~59s before, ~6s after.

  The graph is written 200ms behind the memories it describes and flushed on
  `beforeExit`. Graph indexing was already fire-and-forget and unawaited, so a
  hard kill could always lose the tail; `graphRebuild()` reconstructs it from
  the memories, which are written synchronously.
- `RememberOptions` is now one exported type rather than the same shape restated
  in the port and each of the three adapters, where adding a field left the
  others silently narrower than what they forwarded.

## [0.8.1] - 2026-08-07

### Fixed
- **Recall no longer drops matches older than the newest page.** `recall()`
  truncated each type directory to the newest `limit * 4` files and only then
  applied the archived/agent/tag filters, so a match outside that window came
  back as an empty result rather than a hit — a miss was indistinguishable from
  an absence. `searchMemories`/`scoredSearchMemories` inherited the ceiling
  through a lexical candidate pool capped at `max(limit * 4, 100)`; with no
  embedder configured that fallback is the only search path, so keyword search
  silently saw roughly the newest hundred entries per type and reported
  everything older as nonexistent. Recall now filters before it truncates,
  walking each directory newest-first a page at a time until it has `limit`
  survivors, and both fallbacks score the whole store. Stored memories were
  never lost — they were unreachable.
- **Pruned memories are hidden from live recall.** `pruneStaleMemories`
  documents itself as a soft delete, but only `reflect.ts` checked the flag:
  `recall()` and both search paths ignored it, so a pruned entry still ranked,
  still surfaced, and was still injected into consults. `pruned` is now treated
  like `archived` — hidden by default, recoverable through `includeArchived` —
  and is a real field on `MemoryStoreEntry` rather than a cast, which is what
  let the read and write sites drift apart unnoticed.

### Removed
- **`src/memory/decay.ts`.** `computeDecayScore` and `identifyStaleMemories` had
  no caller outside a test; maintenance implements its own staleness check and
  never consulted them. Their presence implied Oracle decays memory relevance
  over time, which it does not. The unrelated `decayRate` field stays — it feeds
  the recency term in `scoredSearchMemories`.

### Changed
- Pruning is documented as deliberately manual. `remember()` stamps importance
  0.5, nothing lowers it, and pruning retains anything at or above
  `minImportance` (0.2), so automatic maintenance never soft-deletes a memory
  the operator did not explicitly mark low-value. Callers that want pruning pass
  thresholds that say so.

## [0.8.0] - 2026-08-07

### Added
- **`oracle ask --create-image` / `create_image`** — turns on ChatGPT's Create
  image for one answer through the composer's `+` menu (`chatgpt-browser`
  backend). Generated images were already captured and written to the session's
  artifacts directory; what was missing was any way to ask for one, so it
  depended on ChatGPT deciding a prompt wanted an image. Selection is confirmed
  against the composer before the question is sent, and the consult fails rather
  than returning prose in place of the image that was requested. Image
  generation gets a five-minute timeout floor and is exempt from the stall
  recovery page reload, which would discard a finished render rather than
  rescue a wedged UI.
- **Concurrent `oracle ask` calls on the `chatgpt-browser` backend now run in
  parallel**, each on its own dedicated Chrome window
  (`createDedicatedWindowTarget`), rather than queuing behind one another. A
  same-window dedicated *tab* per request was tried first and rejected by live
  testing: of three concurrent tab-based requests, only the frontmost tab
  produced a real answer, the other two timed out with no response, because
  Chrome/ChatGPT do not process a backgrounded tab in a shared window the same
  way as the active one (`document.visibilityState` differs). A separate OS
  window per request does not have this problem — live-confirmed
  `document.hidden: false` in three simultaneously open windows — and
  live-verified end to end: three concurrent asks with three different
  prompts each returned their own correct answer, running concurrently rather
  than one at a time. Two requests continuing the *same* existing conversation
  still serialize (`withConversationLock`, keyed per conversation, not per
  profile) — posting into one ChatGPT thread from two windows at once is not
  behavior its UI or backend is built to expect — but a fresh chat, or a
  different conversation, is never blocked by another request in flight.

### Fixed
- **Concurrent `oracle ask` calls on the `chatgpt-browser` backend could
  silently answer the wrong question.** Three requests running at once share
  one Chrome profile and, after a first fix in this release closed the
  Chrome-launch race (below), correctly share one Chrome instance too — but
  `findOrCreatePageTarget` also reuses whichever `chatgpt.com` tab is already
  open, so all three then drove the *same tab*, typing and reading against a
  single response stream. Live-reproduced: three concurrent calls with three
  different prompts returned the same wrong answer to all three, with exit
  code 0 and no error. Superseded by the dedicated-window design above, which
  fixes this and also achieves real parallelism rather than trading wrong
  answers for a queue.
- **Two Oracle processes could spawn two Chrome instances onto one profile.**
  `ChromeLauncher.launch()` reads whether a Chrome is already running,
  decides, and only then acts — not atomic across processes. Two callers
  evaluating that at the same moment could each decide "none running" and
  each launch one, after which every later CDP call in whichever process lost
  the race could land on the wrong instance and hang. A widened reuse-probe
  timeout landed earlier in this release (`7b2bb96`) to stop a *slow* Chrome
  from being mistaken for a dead one within a single process's retries — that
  narrowed the window but cannot close it, since the race is between two
  separate processes and probing slower does not make a read-then-write
  sequence atomic across them. A cross-process lock (`withLaunchLock`) now
  serializes the launch decision itself, not just the spawn.
- **Image uploads went to the wrong element.** The live page carries five file
  inputs. Only one sits inside the composer form, and that one declares no
  `accept` attribute; the other four belong to the photo picker and the
  image-generation modal and every one of them declares `accept="image/*"`. The
  first selector Oracle tried was `input[type='file'][accept*='image']`, so
  files were handed to the photo picker rather than the composer. It failed
  intermittently rather than outright, which is why it survived a live
  verification pass. The list now prefers `form input[type='file']`.
- **A failed upload poisoned the next one.** The upload wait counts attachments
  against a baseline taken just before injecting, which only measures the new
  files if the composer starts empty. Chrome keeps the profile between runs, so
  a consult that failed mid-upload left its attachment in place and the next run
  waited for a count it could never reach — producing exactly the alternating
  pass/fail pattern observed. The composer is now cleared first. Measured over
  eight consecutive live runs after the fix: eight passes, against a failure
  roughly every third run before it.
- **`attachment` selectors had already drifted.** All three `data-testid`
  alternates matched zero elements against the live page; only the remove
  control's `aria-label` still resolved, so upload completion was being detected
  by the last fallback in the list. Reordered to lead with what matches.
- **`browser status --selectors` now checks every composer tool** rather than a
  hardcoded pair, so a tool added to the registry without a matching menu entry
  is reported instead of failing later at the point of use.
- **A composer tool the backend cannot engage is now refused, not dropped.**
  `ExecutionBackendRequest.tool` documented that backends unable to honour it
  "must fail rather than answer without it", but nothing enforced this: only the
  browser backend ever read the field, so `--web-search` against `codex`,
  `anthropic`, or any API provider answered normally without searching. There
  was no signal in the result that the request had been ignored. Backends now
  declare a `composerTools` capability and `ConsultService` rejects the consult
  before it is sent. Two existing tests asserted the old behavior — one asked
  the `codex` backend to run a web search and expected an answer.

- **ChatGPT Browser response streaming** — captures conversation responses from
  the CDP Network domain with incremental SSE parsing, full-message and JSON
  patch delta support, optional usage metadata, and DOM polling fallback.
  The path is controlled by `experimental.browserStream` and defaults to
  enabled. Live verification still reports intermittent CDP/renderer failures,
  so the DOM path remains the safety net.

- **`npm run verify:live`** — end-to-end verification against the real
  signed-in account. Every defect found while building the browser backend
  shipped with unit tests passing; what they had in common is that nothing
  checked the observable result. These seven checks assert on state outside the
  process — the bundle actually sent, the session record written, the account's
  own memory listing — including that recalled memory reaches the prompt and
  that a session is still named after its question. Not part of `npm test`: it
  costs real time and a real ChatGPT session. A check may retry once, and says
  so when it does.

- **`oracle browser status --selectors`** — resolves each DOM handle Browser
  Mode depends on against the live page, reporting which alternate matched.
  Falling through to a later fallback is drift that has already started. The
  composer menu carries no `data-testid`, so its entries are checked by opening
  the menu, reading it, and closing it again.

- **`oracle ask --deep-research`** — runs ChatGPT's Deep research for one
  answer. It needs a 45-minute timeout floor instead of the three-minute turn
  default, and the stall-recovery page reload is disabled for it: deep research
  leaves the turn unchanged for minutes by design, and reloading would discard
  the research rather than rescue a wedged UI.

- **`oracle ask --web-search`** — turns on ChatGPT's Web search for a single
  answer through the composer's `+` menu (`chatgpt-browser` backend). The menu
  opens only for trusted input, so it is driven through the browser's event
  pipeline; selection is confirmed against the composer before the question is
  sent, and the consult fails rather than answering as though the web had been
  searched. ChatGPT also searches unprompted when it judges a question needs it,
  so the flag guarantees search was requested, not that its absence means none.

- **`oracle memory graph rebuild`** — discards the entity graph and re-indexes
  every stored memory. Indexing is incremental, so entities extracted under
  older rules survive until their memory is rewritten; this is what applies an
  extractor change to what is already on disk. Reports counts before and after.

- **`oracle browser stop`** — closes the Chrome instance Browser Mode leaves
  running for session reuse, reclaiming its memory. The profile and its ChatGPT
  login stay on disk; running it with nothing up is a no-op.

- **Automatic project-memory recall in `oracle ask` and `oracle_ask`**
  - Memory relevant to the question is recalled and included as a labelled
    prompt block, so answers are grounded in what Oracle has stored. Previously
    both paths sent only the files, docs, and conversation context the caller
    passed explicitly, and a model asked about stored memory would fabricate an
    answer rather than admit the gap.
  - Recalled entries are marked as data, not instructions, and the model is told
    to say it does not know rather than guess.
  - Opt out with `--no-memory` (CLI) or `include_memory: false` (MCP).
  - Recall failures and budget-starved recalls are reported, not silently
    dropped; a failed recall degrades the answer instead of failing the call.

- **Configurable memory store (`memory.store`)**
  - Durable memory can live on this machine (`local`, the default), in the
    signed-in ChatGPT account's Saved Memory (`chatgpt`), or both (`hybrid`).
  - `hybrid` keeps the local store canonical and mirrors only entries that clear
    a policy of minimum importance, memory type, and an optional tag allow-list.
  - Saved Memory can now be read back and deleted, not only written: added
    recall/forget prompt builders with a strict JSON-block parser.
  - Because Saved Memory has no ids, tags, importance, or timestamps, `chatgpt`
    mode keeps a local shadow index and joins it to the remote text by content
    hash. Entries are capped at 2000 characters, reads are best-effort, and a
    write or delete counts only when ChatGPT confirms it.
  - `working` memory never leaves the machine. Entity graph, consolidation,
    decay, and reflection remain local-only in every mode.
  - A failed mirror is logged and reported, never silently dropped, and never
    fails the local write. An unavailable browser backend degrades to local
    memory instead of losing writes.
  - `oracle memory store [local|chatgpt|hybrid]` shows or sets the mode.

### Removed
- **`oracle_web_extract`.** It took a URL and returned page content, which is
  what `oracle_web_fetch` does; the difference was the shape of the answer.
  Fetch now takes an optional `extract` describing what you want, and returns
  structured data via AgentQL instead of text. `oracle web extract` is unchanged
  on the CLI. The default MCP server is 18 tools.

- **Session, skill, oracle-profile, persona, identity-setup, init and
  docs-list tools.** Each configures or inspects something a person decides,
  and each already has a CLI command (`oracle status`, `oracle session <id>`,
  `oracle skill`, `oracle oracle`, `oracle identity`, `oracle init`); doc
  listing folded into `oracle_docs_search`, which now lists when `query` is
  omitted. The default MCP server is 19 tools, from 75 at the start.
  History tools stayed despite being niche, because nothing on the CLI reaches
  them. Note that `oracle_identity_setup` accepted a comma-separated string
  where a list was expected and split it; that leniency lived in the tool's
  schema and went with it — `oracle identity setup` takes explicit flags.

- **Fifteen of the nineteen memory tools.** Reading was split across
  `oracle_memory_list`, `_search` and `_scored_search`; tidying across
  `_consolidate`, `_prune`, `_promote`, `_maintenance`, `_clear` and
  `_graph_prune` — many ways for a client to make the same decision wrong.
  Reading is now `oracle_memory_search` (omit `query` to list recent,
  `mode: "graph"` for entity expansion) and housekeeping is
  `oracle_memory_maintain` with an `action`, which also covers `stats` and
  `reflect`. Entity-graph browsing and the wiki left the MCP surface entirely:
  they are for a person exploring what Oracle knows, and `oracle memory graph`
  and `oracle wiki` already serve that. With the earlier trim the default
  server now advertises 28 tools, down from 75.

- **Messaging, task and GitHub tools from the default MCP surface.** `oracle-mcp`
  advertised 75 tools; 31 of them were `oracle_msg_*`, `oracle_task_*` and
  `oracle_github_*`. Every tool a connected client loads costs it context and
  adds one more way to pick the wrong one, and all three groups are reachable
  through means an agent already has — `oracle msg` / `oracle task` on the CLI,
  and the `gh` CLI. The surface is now 43 tools. Nothing was deleted: the
  implementations still drive the CLI, and `oracle-msg-mcp` continues to serve
  messaging and tasks over MCP for clients that want them.

- **`oracle-memory` MCP sidecar orchestration.** The package is retired, and the
  local file adapter always owned the `.oracle-memory/` on-disk format the
  sidecar merely shared — so the supervisor could only ever spawn, fail, and
  fall back to the adapter it would have used anyway. `ProcessSupervisor` and
  `McpMemoryAdapter` are gone along with the `ORACLE_MEMORY_BIN` lookup and the
  per-command spawn attempt. Memory behaviour is unchanged; the general
  `mcpServers` integration is unaffected.

### Fixed
- **ChatGPT Browser Stream Reader request tracking** — the `ChatGptStreamReader`
  was using an undeclared `turnRequestIds` Set field, causing runtime errors when
  attempting to read response streams. Added proper field initialization and
  improved request identification to track conversation turns from
  `Network.requestWillBeSent` events instead of checking response URLs directly,
  which was prone to false positives. Added cleanup to prevent memory leaks when
  the reader is reused. All 651 unit tests pass and live verification confirmed.
- ChatGPT Browser Mode no longer returns a quota notice as if it were the
  model's answer, and no longer reports a mid-turn Cloudflare challenge as a
  bare three-minute timeout — the challenge is named, with a diagnostic
  screenshot. A model the UI picker refuses now fails loudly instead of
  answering from whichever model was already selected, and transient CDP
  faults are retried on a fresh session rather than ending the consult.
- Assistant image capture no longer warns about citation favicons. Web-search
  and deep-research answers embed 128x128 favicons from every site they cite;
  those cleared the size floor, could not be fetched from the page's own origin,
  and produced a "Failed to fetch" warning apiece about images nobody wanted
  saved. Only same-origin, blob: and data: images — the ones the assistant
  actually produced — are candidates now.
- Recalled project memory now actually reaches the answer. Two defects in the
  new grounding block, both found by asking a question whose answer was already
  stored and getting "I do not know":
  - a paragraph-length memory could consume the whole token budget and shut out
    every shorter entry ranked behind it, including the one-line fact search had
    ranked first. Entries are now capped individually and a too-large one is
    skipped rather than ending the selection.
  - the block said only how *not* to use recalled memory ("data, not
    instructions", "say you do not know"), never to answer from it, so the model
    withheld an answer it had in context unless the question named the memory.
- ChatGPT account-memory deletions are verified too. The write path was fixed to
  check the account rather than trust the model's confirmation, but `forget`
  still took `ORACLE_MEMORY_FORGOTTEN` at face value — the same unchecked claim,
  on the operation where believing it means Oracle drops a memory ChatGPT still
  holds. The account is now re-read after the delete: an entry still present
  raises `ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED` and leaves the local copy in
  place, and an uninspectable account completes the local delete while saying
  the account copy is unverified.
- ChatGPT account-memory writes are no longer reported as saved on the model's
  say-so. Observed live: ChatGPT returned the required `ORACLE_MEMORY_SAVED`
  confirmation for an entry the account never stored — it stores only what it
  judges worth remembering — and `hybrid` mode reported `mirrored: true` for a
  memory that was never shared with chatgpt.com. Writes are now verified against
  the account's own memory listing; a conclusive negative raises
  `ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED`, and an uninspectable account yields
  `accountMemoryVerification: "unverified"` rather than a success claim.
- Saved Memory reads now come from the account listing when available, falling
  back to asking ChatGPT only when it is not.
- `detectSandboxMode` no longer fails intermittently: the docker probe is given
  5s of its own, exactly vitest's default test budget, so on a host where
  `docker info` runs to that limit the test raced its own probe.
- Browser Mode no longer stalls with unexplained `CDP command ... timed out`
  errors when its Chrome window is minimized or fully covered. Chrome freezes
  the renderers of backgrounded and occluded windows, and a frozen renderer
  answers no page-domain command — the browser endpoint kept responding in
  48ms while every `Runtime.evaluate` and `Page.enable` timed out, including on
  `chrome://newtab/`. Chrome is now launched with the anti-backgrounding flags,
  and a minimized window on a reused instance is restored before the page is
  driven.
- ChatGPT Saved Memory reads no longer report a populated account as empty.
  Observed live: after a deletion, ChatGPT answered with an empty list twice
  while four memories were still stored, and `chatgpt` mode reported that as
  "no memories". Emptiness now requires an explicit marker — an empty list, a
  malformed reply, or a refusal all raise `ORACLE_ACCOUNT_MEMORY_UNREADABLE`
  instead of being silently read as an empty memory.
- Windows toast delivery no longer throws a temporal-dead-zone `ReferenceError`
  when PowerShell fails to spawn synchronously.

- **Companion local notification delivery**
  - `CompanionNotifier` channel interface plus a Windows toast adapter that
    passes message text through the environment, never a shell command line,
    and degrades explicitly on non-Windows platforms.
  - Delivery re-checks every Boundary gate (pause, freshness, superseded
    presence, `focus`/`transit`, quiet hours) and fails closed to suppression;
    `silence` intents never reach a channel.
  - Channels ship disabled and are enabled per channel by the user.
  - Per-(intent, channel) uniqueness, a delivery cooldown, persisted delivery
    history, and SQLite schema v11.
  - `oracle companion channels|channel|notify-test|deliveries`, authenticated
    Runtime APIs, and `companion.channel.updated` plus
    `companion.delivery.*` replayable events that exclude message text and raw
    channel output.

- **Situated Companion MVP**
  - Semantic-only presence for `home`, `work`, `transit`, `focus`, `available`,
    `away`, and `unknown`; raw coordinate fields are rejected.
  - Persistent, explainable `speak` or `silence` intents with freshness,
    confidence, provenance, quiet-hour, interruption, privacy, and pause gates.
  - `oracle companion status|presence|evaluate|pause|resume|forget`, authenticated
    Runtime APIs, replayable events, and SQLite schema v10.

- **ChatGPT Browser Mode (experimental desktop backend; macOS-first with Windows/Linux compatibility)**
  - Automated Chrome automation via Chrome DevTools Protocol (`--remote-debugging-port`) using Oracle's isolated profile.
  - Commands: `oracle browser setup`, `oracle browser login` (manual OAuth recovery flow), `oracle browser status`, `oracle browser status --live` (live session verification), `oracle browser open`.
  - Native Conversation Continuation via `--conversation <id>` or `conversationId` allowing continuous multi-turn threads on `chatgpt.com`.
  - Explicit ChatGPT account Saved Memory writes via CLI `--remember <text>` or MCP/Runtime `accountMemory`, isolated from the normal project bundle with confirmation-only session metadata.
  - PNG/JPEG/WebP round-trip support: workspace-confined image upload through the ChatGPT composer, assistant-image capture into session artifacts, MCP image content responses, and Runtime/CLI metadata.
  - Image hardening with magic-byte MIME verification, input/output size and count limits, realpath containment, generated artifact names, and in-browser asset fetching to avoid Node-side SSRF.
  - Self-healing response recovery via automatic page reload (`Page.reload`) when the ChatGPT response stream or UI stalls without completion controls.
  - CDP execution-context retries for handling transient DOM destruction errors (`Execution context was destroyed`, `Promise was collected`, `Cannot find context`).
  - Strict no-partial-response enforcement ensuring outputs are returned only when completion action buttons (`hasCompletionAction`) are confirmed.
  - Backends integration (`--backend chatgpt-browser`) for `oracle ask` and `oracle doctor`.
  - HTTP endpoints `POST /v1/consult` and `GET /v1/consult/:sessionId` in Runtime API.
  - Isolated Chrome profile, visible/manual login, profile-owned dynamic CDP port,
    response-stream stabilization, timeouts, and diagnostic screenshots.

- **Centralized `BundleService` & `ExecutionBackend` Abstraction**
  - Unified file resolution, secret scanning, size validation, token estimation, and manifest generation across all backends.
  - Standardized capability reporting (`ExecutionBackendCapabilities`) and `healthCheck()` contract.
  - Automatic migration from legacy `"provider"` configuration key to `"backend"`.

### Changed
- Migrated from the monolithic MCP TypeScript SDK v1 to the stable v2
  `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and
  `@modelcontextprotocol/core` packages.
- Oracle's stdio servers now negotiate the stateless MCP `2026-07-28`
  protocol while retaining automatic compatibility with legacy 2025 clients.
- Oracle's outbound MCP clients now auto-negotiate modern or legacy protocol
  eras, and the MCP smoke test reports the negotiated version and era.

### Fixed
- Background memory maintenance no longer keeps an MCP stdio process alive
  after its client disconnects.
- Runtime consult requests now confine `cwd` to the daemon workspace root.
- MCP per-call backend overrides now resolve the requested backend instead of
  only changing session metadata.

## [0.7.0] - 2026-07-27

### Added
- **Cost & token accounting** — provider spend is recorded and queryable
  - `CostTracker` aggregates by window (today/week/month/all), provider, and agent
  - Schema v8 `cost_log` table, indexed by time, agent, and provider
  - Built-in price table (per 1M tokens) with longest-prefix model matching;
    local providers are free, unknown models report `$0` rather than a guess
  - `oracle usage [window] [--agent]`, `oracle usage budget <limit>`, `oracle usage prune`
  - `oracle ask --agent <name>` attributes a call; unattributed calls are
    reported as `(unattributed)` instead of being dropped
  - Budget checks return ok / warn (80%) / exceeded, and `budget` exits 1 when over

- **Gemini provider** — `gemini-2.0-flash`, `gemini-2.0-pro`, `gemini-1.5-*`
  - REST-based, so no new dependency is added
  - API key sent as an `x-goog-api-key` header, never in the URL
  - Safety blocks raise an error rather than returning an empty answer
  - `oracle models` lists every provider's models and which have credentials
  - `providerForModel()` routes a model name to its provider

- **Sandbox hardening** — real containment for the agent's `bash` tool
  - Docker mode: no network, capped memory/swap/cpu, `--pids-limit` fork ceiling,
    all capabilities dropped, `no-new-privileges`, read-only root with a
    writable workspace mount and a `noexec` tmpfs
  - Namespace mode: unshared user/pid/net namespaces via `unshare(1)` with a
    `ulimit -u` fork ceiling (Linux only)
  - `detectSandboxMode()` picks the strongest available; requesting a mode the
    host cannot provide is an error, never a silent downgrade to no isolation
  - Schema v8 `sandbox_runs` table for mode, duration, exit code, and kills

- **Memory graph visualization** — the entity graph is now inspectable
  - `EntityGraph.toGraphView()` returns render-ready nodes/edges ranked by
    connectedness; edges to dropped nodes are filtered so no edge dangles
  - Truncated views report `stats.truncated` so a partial graph never reads
    as the whole graph
  - `EntityGraph.getEntity()` returns relations with direction and weight
  - `oracle memory graph show|entity|path`

- `oracle login --status` reports the stored session's plan and whether it is
  active, refreshable, or needs a re-login. Notes when `ANTHROPIC_API_KEY` is set
  and therefore takes precedence over the session.
- Tests for the auth module (32): token store round-trips, permissions,
  corrupt-file handling, refresh rotation, concurrent-refresh de-duplication,
  cross-process refresh adoption, plan-tier decoding, and factory OAuth wiring.
- Web dashboard Scheduler card with Run, Pause/Resume, and Delete job actions

### Fixed
- **Anthropic OAuth functionality:** fixed provider building, `checkProvider("anthropic")` credential testing, refresh client id resolution, owner-only token file permissions (`0600`), and error reporting for consult failures.

### Changed
- `ConsultService` accepts an optional `CostSink`; accounting failures are
  swallowed so bookkeeping can never fail a successful consult
- `ConsultRequest` gains an optional `agent` field for cost attribution
- `EntityGraph.getEntity()` falls back to a case-insensitive lookup, so
  `entity redis` finds a node stored as `Redis`
- Schema v8 supersedes v7

### Fixed
- `adapter.e2e.test.ts` recency test read from `.oracle-memory/fact/` instead of
  the real `facts/` directory, so it never exercised the ranking it asserted

### Known issues
- On Windows, `src/tasks/store.test.ts` and several other SQLite-backed suites
  fail in teardown with `EBUSY` unlinking `oracle.db`. This predates 0.7.0 and
  is a file-locking quirk of the platform, not a product defect; CI runs Linux.

## [0.6.0] - 2026-07-25

### Added
- **Memory Engine Foundation** — SQLite-backed vector + BM25 hybrid retrieval
  - `SQLiteVectorStore`: Indexed vector search (O(log n) vs O(n) JSON scan)
  - `BM25Store`: Native FTS5 full-text search with phrase matching
  - `HybridRetrieval`: RRF (Reciprocal Rank Fusion) combines semantic + lexical scores
  - Auto-migration from `vectors.json` → SQLite embeddings table on first daemon run
  
- **Pluggable Embedding Providers**
  - Interface: `EmbeddingProvider` with `embed(text) → Promise<number[]>`
  - Implementations: Ollama (local), Voyage, OpenAI, Gemini
  - Auto-detection: `globalRegistry.detectAvailable()` tries providers in priority order
  - Graceful fallback: if embedder unavailable, BM25-only still retrieves results
  
- **Evaluation Harness** (`EvalHarness`)
  - Metrics: recall@1/5/10, Mean Reciprocal Rank (MRR)
  - Baseline measurement: 0.5.0 (keywords) vs 0.6.0 (hybrid retrieval)
  - Dataset: 20 eval queries covering architecture, debugging, orchestration
  
- **CI Pipeline** (`.github/workflows/ci.yml`)
  - Build, test, verify (181 tests), CLI smoke, runtime smoke, type-check
  - Runs on every push/PR to main and feature branches
  
- **Configuration Schema** (`.oracle/config.json`)
  - `memory.embeddingProvider`: Choose provider (ollama, voyage, openai, gemini)
  - Environment variable detection: `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`
  - `memory.hybridSearchK`: Tune RRF parameter (default: 60)
  - `memory.bm25Only`: Force lexical-only search (debug mode)
  
- Integration tests for hybrid retrieval (fallback, ranking, consolidation)

### Changed
- `MemoryAdapter.searchMemories()`: Uses hybrid search with RRF fusion instead of semantic-only
- `MemoryAdapter.scoredSearchMemories()`: Ranks hybrid results with recency weighting
- `MemoryAdapter.remember()`: Indexes into both vector store + BM25 simultaneously
- Vector indexing no longer silently fails when Ollama unavailable; graceful fallback instead
- Schema v7: Added `memory_embeddings` table (BLOB vectors), FTS5 `memory_content_search`

### Performance
- Vector search: **O(n) → O(log n)** with SQLite indexing (50k memories: 500ms → <100ms)
- Retrieval fusion: BM25 + vector scores merged via RRF, not either/or
- Concurrent writes safe via SQLite WAL + transaction locking (was: JSON file race)

### Backwards Compatibility
- `vectors.json` auto-migrates on first daemon startup; kept as fallback
- Legacy `USE_OLLAMA` env flag still respected
- Lexical-only search available if no embedder configured (no errors)
- No changes to `MemoryPort` public API

### Security
- Embedding API keys loaded from env vars only (not committed to config)
- Vector embeddings stored in SQLite with same file perms as runtime DB

### Documentation
- New: `docs/config-schema.md` — embedding provider setup and configuration
- Updated: `docs/roadmap-0.6.0.md` — detailed implementation + file references
- Updated: `docs/index.md` — added roadmap link (row 19)
- Web dashboard Agents presence list with active/stale indicators and relative timestamps
- Web dashboard filter input for approvals and Run maintenance button
- Web dashboard toast component for non-disruptive success/error feedback
- Web dashboard audit-chain integrity badge (`chain valid` / `broken @ N`)
- Task workflow action buttons (Submit / Close) directly in the web dashboard
- Ink TUI per-tab actions: task submit (`s`) and close (`c`), scheduler run (`r`), pause/resume (`p`), delete (`d`), memory maintenance (`m`)
- Ink TUI WebSocket live updates with connection status indicator (`● LIVE` / `○ POLL`)
- Ink TUI per-tab selection and scroll offset, responsive title width, and contextual key hints
- Ink TUI global memory entries display (previously fetched but never rendered)
- Shared `format.ts` helpers (`clean`, `truncate`, `shortAge`, `riskTone`) used by both TUIs and CLI
- `POST /v1/control/tasks/:id/submit` and `POST /v1/control/tasks/:id/close` daemon endpoints
- `POST /v1/control/memory/maintenance` daemon endpoint
- `RuntimeClient.submitControlTask`, `closeControlTask`, `runMemoryMaintenance` methods
- Unit tests for `format.ts`, `ink-state.ts`, and `live.ts` modules (46 tests)

### Changed
- `--actor` default fallback chain uses `os.userInfo().username` with `USER`/`USERNAME` env on Windows
- Plain-TUI error handling catches decide and refresh failures into a status message instead of crashing the session
- Plain-TUI rejection note now unifies with Ink TUI (`"Rejected from Oracle Control."`)
- Ink TUI footer message color uses explicit `statusKind` property instead of substring-matching "error"
- Ink TUI `ConnectionStatus` state machine extracted to pure module (`ink-state.ts`)
- Web dashboard WebSocket handler debounces event-triggered reloads (250ms) and shows offline/polling immediately on disconnect
- Web dashboard header shows relative `Updated X ago` timestamp
- `oracle control url` CSP and page content unchanged

### Fixed
- Guard against undefined `selectedApproval` in Ink TUI confirm prompt
- Ink TUI `j`/`k` no longer mutate approval selection while viewing other tabs
- `agent.name`, `agent.role`, `schedule.cron`, `schedule.name`, `task.assignee` fields now sanitized with `clean()`

## [0.5.0] - 2026-07-24

### Added
- Remote Swarm project rooms for cross-machine agent coordination
- Project- and agent-scoped tokens with SHA-256 hashes stored in SQLite
- Remote presence, direct/broadcast messaging, per-agent acknowledgements,
  verified task lifecycle, and project-filtered WebSocket events
- Replay-after-reconnect support through persisted Runtime event ids
- `oracle connect` and `oracle team status|agents|send|inbox|ack|watch`
- Remote token revocation through `oracle team token-revoke`
- `oracle team task create|list|get|update|check|submit|close`
- Explicit `oracle daemon start|run --remote` gate for non-loopback bindings
- Non-destructive legacy import for local message, task, presence, and swarm
  workflow JSON

### Changed
- Package version advanced to Remote Swarm 0.5.0
- Local messages, acknowledgements, tasks, and agent presence now use the
  Runtime SQLite database instead of mutable JSON records
- Local message watch uses SQLite WAL changes as wake-up signals and queries
  the database as its source of truth
- Runtime database schema advanced to version 6

### Security
- Remote tokens never grant shell, filesystem, Scheduler, approval, or admin
  Runtime access
- WebSocket clients receive only events for their token's project
- Raw Remote Swarm tokens are returned once and never persisted by the host
- Non-loopback binding remains rejected unless explicitly enabled
- Cross-machine deployments require TLS termination or an encrypted private
  network; Oracle does not expose its HTTP listener as TLS

## [0.4.0] - 2026-07-24

### Added
- Human approval execution gate with pause, persistent checkpoint, payload verification, resume, and execute-once claim
- Authorized reviewers, multi-reviewer quorum, immutable votes, expiry, and optimistic-lock versions
- Canonical SHA-256 action payload hashes and SQLite-backed execution records
- Tamper-evident audit hash chain with cross-process writer locking and `oracle audit verify`
- Ink Control Center TUI with overview, approval, task, memory, audit, agent, and scheduler tabs
- Approval filtering, detail inspection, rejection reasons, and confirmation prompts in the TUI
- Optional Telegram callback decisions with chat/user allowlists, expiring versioned callbacks, and replay protection
- Runtime API and WebSocket events for votes, expiry, and guarded action execution
- SQLite v2-to-v3 migration coverage and end-to-end human-control-plane tests

### Changed
- Package version advanced to Human Control Plane 0.4.0
- `oracle control` uses Ink in interactive terminals; `--plain` keeps the dependency-free ANSI renderer
- Agent checkpoints expose waiting-approval state, approval id, and pending tool
- Control snapshots now include agent presence, scheduler records, and audit-chain integrity
- High-risk Telegram decisions are local-only by default

### Security
- Guarded tools do not run before an authorized quorum approves the exact hashed payload
- SQLite uniqueness prevents more than one execution claim for an approval
- Stale approval decisions return conflicts instead of overwriting newer state
- Telegram callbacks validate chat, user allowlist, reviewer identity, version, and local-only policy

## [0.3.0] - 2026-07-24

### Added
- Blue, responsive Control Center dashboard served locally at `/control`
- Dependency-free interactive terminal UI through `oracle control`
- Persistent SQLite approval inbox with low/medium/high risk classification
- Automatic task-review approvals linked to the existing TaskStore and CoordinationService
- Approval CLI for request, list, show, approve, and reject workflows
- Control Center snapshot API aggregating task, memory, audit, approval, and Runtime state
- Optional Telegram approval notifications through environment configuration
- Control Center unit, API, terminal rendering, and daemon smoke coverage

### Changed
- Package version advanced to Control Center 0.3.0
- Runtime state records its fixed project workspace for safe visualization
- SQLite schema advanced to version 2 with persistent approval records
- Task approval decisions reuse the durable Task-to-Message coordination flow

### Security
- Dashboard data and mutations remain protected by the owner-only Runtime token
- Dashboard token is passed in the URL fragment, moved into session storage, and removed from the address bar
- Telegram is disabled unless both bot token and chat id are explicitly configured
- Telegram is notification-only; decisions remain inside the authenticated local Control Center

## [0.2.0] - 2026-07-24

### Added
- Persistent `oracle-daemon` process with background and foreground lifecycle commands
- SQLite runtime backend using WAL mode for scheduler tasks, run history, metadata, and events
- Scheduler service owned by the daemon, with idempotent import of legacy JSON tasks
- Token-authenticated loopback HTTP API for scheduler and daemon operations
- WebSocket event stream with SQLite-backed cursor replay
- `oracle daemon start|run|status|stop|events`
- `oracle schedule update` with live rescheduling through the daemon API
- Runtime integration and smoke tests covering API, WebSocket, SQLite, and process lifecycle

### Changed
- Package version advanced to Runtime 0.2.0
- Scheduler CLI commands use the daemon API when available and the same SQLite backend when offline
- `oracle schedule watch` is now a compatibility alias for foreground Runtime

### Security
- Runtime rejects non-loopback bind addresses
- Daemon API credentials are owner-only and redacted from status output

## [0.1.0] - 2026-07-24

### Added
- Durable coordination outbox linking every task lifecycle notification to its persisted message
- Persistent swarm-to-task linkage through `primaryTaskId`, `taskIds`, and `messageIds`
- `oracle swarm recover` and `oracle_coordination_recover` for idempotent workflow recovery
- Automatic migration of legacy swarm proposals into the TaskStore consensus source of truth
- Persistent cron task system (`oracle schedule`) with `list`, `add`, `remove`, `run`, `watch`, `--once` commands
- Agent checkpoint store with list/resume/delete support
- Agent plan mode (`--plan`) for read-only investigation before execution
- Agent self-review mode (`--review`) for post-completion correctness checks
- Agent resume from checkpoint (`--resume <id>`) after `--max-steps` or crash
- Agent JSON output mode (`--json`) for structured `finalText`, `steps`, `checkpointId`
- Bash tool with `$SHELL` respect (Git Bash on Windows, user shell on Unix)
- Codex CLI provider integration
- Cross-tool session history recall (`oracle_history_sources`, `oracle_history_search`)
- `oracle_msg_search` — time-first recall over the whole message bus
- tmux real-time push watcher (`scripts/oracle-tmux-launch.sh`, `scripts/oracle-tmux-push-watcher.mjs`)
- `oracle msg watch` with `--exec` for custom nudge commands
- `oracle msg inbox` blocking wait mode (`--wait --timeout`)
- AST graph memory module (`src/memory/astGraph.ts`)
- Memory decay module (`src/memory/decay.ts`)
- Agent policy module (`src/agent/policy.ts`)
- Task consensus module (`src/tasks/consensus.ts`)
- Observability audit trail (`src/observability/audit.ts`)
- Multi-agent swarm execution (`src/orchestrator/swarm.ts`)
- Scheduler docs (`docs/scheduler.md`)
- LICENSE, CONTRIBUTING.md, SECURITY.md, SUPPORT.md at repo root
- CLI reference (`docs/cli-reference.md`) and troubleshooting guide (`docs/troubleshooting.md`)
- Signatures on all docs
- Updated `docs/AGENT.md` with plan/review/resume/JSON flags
- Updated `docs/MCP-STANDARDS.md` to reflect 49 tools, removed GitHub tools section
- Updated `docs/index.md` as a real GitHub Pages landing page

### Changed
- TaskStore is now the canonical consensus store; SwarmStore keeps a recoverable workflow projection
- Coordination messages carry `taskId`, `workflowId`, and `coordinationEventId`
- Package version advanced to Coordination 0.1.0
- `docs/AGENT.md` — rewritten with current CLI flags, checkpoint/resume, self-review, source map
- `docs/MCP-STANDARDS.md` — rewritten with 49 tools, new categories, error handling checklist
- `docs/index.md` — fixed duplicate entries, added CLI Reference and Troubleshooting links
- Moved `MESSAGING.md` out of `package.json` files array (now only in `docs/`)

### Removed
- `oracle_github_*` tools from all documentation
- Duplicate "Superpowers / Plans" entry from docs/index.md
- `docs/` folder restructure — moved root docs into `docs/` for GitHub Pages
- `docs/index.md` reordered documentation table (new user → deeper reference)
- `docs/MESSAGING.md` relative link fixes from root to `docs/`

### Changed
- MCP tools reorganized into category files under `src/mcp/tools/`
- `CheckpointStore` renamed to `FileCheckpointStore` in agent module
- Agent loop supervisor timeout behavior hardened against fast-fallback hangs
- Agent stdout pollution prevented in orchestrator
- `package.json` files array updated to include `docs`
- README and docs links updated to use `docs/` relative paths

### Fixed
- Interrupted task notifications resume without duplicate messages
- Legacy swarm workflows recover missing linked tasks and proposal ownership
- `oracle_msg_inbox` wait mode timeout and re-arm behavior
- Agent `stdout` pollution breaking MCP protocol framing
- Fast-fallback orchestrator supervisor timeouts
- Windows bash tool shell selection (`$SHELL` fallback)
- Built CLI import paths for the swarm and audit commands
- Swarm workflow state now persists across separate CLI invocations
- Task consensus proposals and votes now persist and accumulate
- Agent tool and policy-denial events now populate `.oracle/audit.jsonl`
- Agent policy loading now fails closed and enforces mutation limits
- Message inbox ordering is deterministic for rapid sequential sends

## [0.0.2] - 2026-07-24

### Added
- Agent resume, plan mode, JSON output, self-review, checkpoint list
- Bash tool and codex agent provider
- Cross-tool session-history recall
- `oracle_msg_search` time-first recall
- tmux real-time push for idle sessions
- 4-tier wake-up model documentation and implementation
- `oracle msg watch` CLI command
- `oracle msg inbox` wait mode
- Agent checkpoint system
- Task planning, tracking, and verification layer
- MCP tool category extraction and error recovery
- Docs: worked example (standby workers + tmux push)
- Docs: 4-tier wake-up model
- Docs: agent flags (plan, review, resume, json, checkpoints)
- Docs: Oracle MCP setup guide and Claude Code integration
- Docs: GitHub Pages content rewrite to match current Oracle
- Repo flatten — `Oracle/` subfolder contents moved to repo root

### Changed
- Agent and messaging tooling matured from prototype to production-ready
- Docs restructured to match current CLI surface

## [0.0.1] - 2026-07-15

### Added
- Initial release: MCP server + CLI with memory, consultation, agent, messaging, and task tracking
- Persistent memory with BM25 + vector search + entity graph
- Consultation engine (`oracle ask`) with code/memory/docs/web context
- Autonomous agent sandbox with audit trail
- Inter-agent message bus (`oracle msg`)
- Task planning & verification (`oracle task`)
- Identity and persona system
- GitHub integration tools
- Docs & web tools
- Session history recall tools
- Oracle profiles & skills system
