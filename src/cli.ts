#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { VERSION } from "./version.js";
import { ConsultService } from "./core/consult.js";
import {
  checkBackend,
  createExecutionBackend,
  createAgentBackend,
  AGENT_BACKENDS,
  parseBackendName,
  parseProviderSelection
} from "./providers/factory.js";
import { loadProjectConfig, type ProjectConfig } from "./config/project.js";
import { resolveProviderRoute } from "./providers/router.js";
import {
  buildBrowserServiceInvocation,
  formatBrowserServiceInvocation,
  runBrowserService,
} from "./browser/service.js";
import { AgentService } from "./agent/service.js";
import { FileSessionStore } from "./session/store.js";
import {
  ensureProjectConfig,
  generateMcpSetup,
  writeMcpSetup,
  type McpClient
} from "./setup/mcp.js";
import { AnthropicOAuthClient } from "./auth/anthropic-oauth.js";
import { TokenStore } from "./auth/store.js";
import { SkillRegistry } from "./skills/registry.js";
import { OracleRegistry } from "./oracles/registry.js";
import { OrchestratorFactory } from "./orchestrator/factory.js";
import { DEFAULT_SYSTEM_PROMPT } from "./context/bundle.js";
import { ProfileStore } from "./identity/profile.js";
import { MessageStore } from "./messaging/store.js";
import { TaskStore } from "./tasks/store.js";
import { CoordinationService } from "./coordination/service.js";
import { SwarmStore } from "./orchestrator/swarmStore.js";
import { RuntimeClient } from "./runtime/client.js";
import {
  PRESENCE_SOURCES,
  PRESENCE_STATES,
  type CompanionDelivery,
  type CompanionIntent,
  type PresenceSource,
  type PresenceState
} from "./companion/types.js";
import {
  SwarmClient,
  removeSwarmProfile,
  saveSwarmProfile,
  type SwarmConnectionProfile
} from "./runtime/swarmClient.js";
import { ACTBEngine } from "./governance/actb.js";
import { daemonStatus, startDaemon, stopDaemon } from "./runtime/control.js";
import { riskTone } from "./control/format.js";
import type {
  CreateTaskInput as CreateCronTaskInput,
  CronTask,
  UpdateTaskInput as UpdateCronTaskInput
} from "./scheduler/taskStore.js";
import * as gh from "./github/gh.js";
import type { PRFile } from "./github/types.js";
import { listDocs, searchDocs, addDoc, removeDoc } from "./docs/reader.js";
import { webSearchWithTrace } from "./web/search.js";
import { fetchUrl } from "./web/fetchUrl.js";
import { agentqlExtract } from "./web/providers/agentql.js";
import { loadSoul } from "./core/souls.js";
import { buildOracleSystemPrompt } from "./core/systemPrompt.js";
import { getConversationContext, recordSelfLog } from "./core/selfMemory.js";
import { buildMemoryContext } from "./core/memoryContext.js";
import { buildWiki, getWikiPage, listWikiTopics } from "./wiki/compile.js";

/**
 * Open a cost-logging sink backed by the runtime database.
 *
 * Accounting must never be the reason a consult fails, so a database that
 * cannot be opened yields a no-op sink rather than an error.
 */
async function createCostSink(): Promise<{
  sink: import("./core/consult.js").CostSink | undefined;
  close: () => void;
}> {
  try {
    const [{ RuntimeDatabase }, { CostTracker }] = await Promise.all([
      import("./runtime/database.js"),
      import("./runtime/costTracker.js"),
    ]);
    const database = new RuntimeDatabase(homeDir());
    const tracker = new CostTracker(database.connection);
    return {
      sink: (entry) => tracker.log(entry),
      close: () => { try { database.close(); } catch { /* ignore */ } },
    };
  } catch {
    return { sink: undefined, close: () => {} };
  }
}

const homeDir = (): string =>
  process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");

function backendRuntimeOptions(config: ProjectConfig) {
  const configuredProfile = config.browser?.profileDir;
  return {
    homeDir: homeDir(),
    experimentalBrowserMode: config.experimental?.browserMode,
    browser: {
      ...config.browser,
      browserTimeout: config.browser.timeout,
      browserInputTimeout: config.browser.inputTimeout,
      maxConcurrentTabs: String(config.browser.maxConcurrentTabs),
      profileDir: configuredProfile
        ? path.resolve(homeDir(), configuredProfile)
        : path.join(homeDir(), "chrome-profile")
    },
    azure: config.azure,
    openrouter: config.openrouter
  };
}

const program = new Command()
  .name("oracle")
  .description("Oracle — MCP-powered AI coding consultant")
  .version(VERSION);

// ── ask ──────────────────────────────────────────────────────────
program
  .command("ask")
  .description("Ask Oracle anything, one entry point — pass -f to also look at code")
  .argument("<question>", "Your question")
  .option("--soul <name>", "Soul prompt name (~/.oracle/souls/<name>.md)")
  .option("-f, --file <pattern...>", "File paths or glob patterns to include")
  .option("--conversation <id>", "Stable id so Oracle recalls what it already told you across calls")
  .option("--remember <text>", "Explicitly save a high-level fact or preference to ChatGPT account memory (chatgpt-browser only)")
  .option("--include-docs", "Search .oracle/docs/ for relevant documentation")
  .option("--no-memory", "Answer without recalling stored project memory")
  .option("--web-search", "Turn on ChatGPT's Web search for this answer (chatgpt-browser only)")
  .option("--deep-research", "Turn on ChatGPT's Deep research for this answer; takes many minutes (chatgpt-browser only)")
  .option("-m, --model <model>", "Model override")
  .option("--backend <backend>", "Backend override (codex, openai, anthropic, gemini, opencode, browser, chatgpt-browser, azure, openrouter)")
  .option("--provider <provider>", "Provider override (deprecated: use --backend)")
  .option("--remote-chrome <host>", "Chrome DevTools endpoint")
  .option("--remote-host <host>", "Remote Oracle browser service")
  .option("--remote-token <token>", "Remote browser token (prefer ORACLE_REMOTE_TOKEN)")
  .option("--browser-manual-login", "Use a persistent manual-login Chrome profile")
  .option("--browser-attach-running", "Attach to an already-running local Chrome")
  .option("--browser-model-strategy <strategy>", "select, current, or ignore")
  .option("--browser-timeout <duration>", "Overall browser response timeout")
  .option("--browser-auto-reattach-delay <duration>", "Delay before first reattach")
  .option("--browser-auto-reattach-interval <duration>", "Reattach interval")
  .option("--browser-auto-reattach-timeout <duration>", "Per-attempt reattach timeout")
  .option("--cwd <path>", "Working directory", process.cwd())
  .option("--agent <name>", "Attribute this call to an agent for cost accounting")
  .action(async (question, options) => {
    const cwd = path.resolve(options.cwd);
    const config = await loadProjectConfig(cwd);
    const selection = options.backend
      ? parseBackendName(options.backend)
      : parseProviderSelection(options.provider ?? config.provider ?? config.backend);
    const requestedModel =
      options.model ??
      (selection === "browser" ? config.browser.model : config.model);
    const route = resolveProviderRoute({
      model: requestedModel,
      selection,
      selectionSource: options.provider ? "explicit" : "project-config",
      config,
    });
    const browserOptions = {
      profileDir: config.browser.profileDir,
      timeoutMs: config.browser.timeoutMs,
      manualLogin: options.browserManualLogin ?? config.browser.manualLogin,
      attachRunning: options.browserAttachRunning ?? config.browser.attachRunning,
      remoteChrome: options.remoteChrome ?? config.browser.remoteChrome,
      remoteHost:
        options.remoteHost ?? process.env.ORACLE_REMOTE_HOST ?? config.browser.remoteHost,
      remoteToken: options.remoteToken ?? process.env.ORACLE_REMOTE_TOKEN,
      chatgptUrl: config.browser.chatgptUrl,
      modelStrategy: options.browserModelStrategy ?? config.browser.modelStrategy,
      tab: config.browser.tab,
      thinkingTime: config.browser.thinkingTime,
      research: config.browser.research,
      followUps: config.browser.followUps,
      archive: config.browser.archive,
      attachments: config.browser.attachments,
      bundleFiles: config.browser.bundleFiles,
      bundleFormat: config.browser.bundleFormat,
      port: config.browser.port,
      browserTimeout: options.browserTimeout ?? config.browser.timeout,
      browserInputTimeout: config.browser.inputTimeout,
      attachmentTimeout: config.browser.attachmentTimeout,
      recheckDelay: config.browser.recheckDelay,
      recheckTimeout: config.browser.recheckTimeout,
      heartbeat: config.browser.heartbeat,
      reuseWait: config.browser.reuseWait,
      profileLockTimeout: config.browser.profileLockTimeout,
      maxConcurrentTabs: String(config.browser.maxConcurrentTabs),
      hideWindow: config.browser.hideWindow,
      autoReattachDelay:
        options.browserAutoReattachDelay ?? config.browser.autoReattachDelay,
      autoReattachInterval:
        options.browserAutoReattachInterval ?? config.browser.autoReattachInterval,
      autoReattachTimeout:
        options.browserAutoReattachTimeout ?? config.browser.autoReattachTimeout,
    };
    const runtimeOptions = {
      ...backendRuntimeOptions(config),
      browser: {
        ...browserOptions,
        profileDir: config.browser.profileDir
          ? path.resolve(homeDir(), config.browser.profileDir)
          : path.join(homeDir(), "chrome-profile")
      }
    };
    const checks = await checkBackend(route.provider, runtimeOptions);
    const failedCheck = checks.find((chk) => !chk.ok);
    if (failedCheck) throw new Error(`${failedCheck.name}: ${failedCheck.detail}`);

    const { sink: costSink, close: closeCostSink } = await createCostSink();
    const service = new ConsultService(
      createExecutionBackend(route.provider, runtimeOptions),
      undefined,
      costSink
    );
    const soulsDir = path.join(homeDir(), "souls");

    // Build system prompt — use specific soul if --soul given, otherwise auto-detect mood
    const soulPrompt = options.soul ? await loadSoul(options.soul, soulsDir) : undefined;
    const awarenessContext = await new ProfileStore(homeDir()).buildAwarenessContext({
      workspaceRoot: cwd,
      interface: "cli",
      backend: route.provider
    });
    const systemPrompt = buildOracleSystemPrompt(soulPrompt, awarenessContext);

    const orchestrator = new OrchestratorFactory(cwd, homeDir());
    const memory = await orchestrator.createMemoryAdapter();

    let ctxBlock = "";
    if (options.conversation) {
      ctxBlock += await getConversationContext(memory, options.conversation);
    }
    if (options.memory !== false) {
      // A recall failure must not sink the consult — the question is still
      // answerable without stored memory — but it is reported, because a silent
      // drop looks identical to "nothing was remembered".
      try {
        const recalled = await buildMemoryContext(memory, question);
        ctxBlock += recalled.block;
        if (recalled.used === 0 && recalled.omitted > 0) {
          console.warn(
            `[memory] ${recalled.omitted} recalled item(s) did not fit the context budget; answering without project memory.`
          );
        }
      } catch (error) {
        console.warn(
          `[memory] recall failed, answering without project memory: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (options.includeDocs) {
      const matched = await searchDocs(cwd, question, 5);
      if (matched.length > 0) {
        const docsBlock = matched.map((d) => `### ${d.name}${d.heading ? ` — ${d.heading}` : ""}\n${d.snippet}`).join("\n\n");
        ctxBlock += `\n\n## Documentation from .oracle/docs/\n${docsBlock}`;
      }
    }

    const hasFiles = Boolean(options.file?.length);
    const result = await service.consult({
      prompt: `${ctxBlock}\n\n## Question\n${question}`,
      title: question,
      tool: options.deepResearch
        ? "deep-research"
        : options.webSearch ? "web-search" : undefined,
      preset: "review",
      provider: route.provider,
      conversationId: options.conversation,
      accountMemory: options.remember,
      files: hasFiles ? options.file : [],
      model: route.model,
      cwd,
      systemPrompt,
      allowEmptyFiles: !hasFiles,
      agent: options.agent
    });
    closeCostSink();

    if (result.status !== "completed") {
      // The failure reason lives on the record. Printing only `output` here
      // meant a failed consult exited 1 having said nothing at all, leaving no
      // way to tell an auth problem from a network one.
      console.error(`Consult failed: ${result.error ?? "unknown error"}`);
      if (result.output) console.error(result.output);
      process.exitCode = 1;
      return;
    }

    if (options.conversation) {
      await recordSelfLog(memory, options.conversation, { question, answerSummary: result.output.slice(0, 400) });
    }

    console.log(result.output);
    if (result.accountMemoryRequested) {
      // "Saved" is only claimed for a write checked against the account; an
      // unverifiable one must not read as success.
      console.error(
        result.accountMemoryVerification === "verified"
          ? "[memory] saved to your ChatGPT account and confirmed present."
          : "[memory] ChatGPT reported the save, but it could not be confirmed against your account. Check Settings > Personalization > Manage memories."
      );
    }
    for (const image of result.images ?? []) {
      console.log(`[image] ${image.path} (${image.mimeType}, ${image.sizeBytes} bytes)`);
    }
    for (const warning of result.artifactWarnings ?? []) {
      console.warn(`[artifact warning] ${warning}`);
    }
  });

// ── oracle ───────────────────────────────────────────────────────
program
  .command("agent")
  .description("Autonomously carry out a coding task with a tool-use loop")
  .argument("<task>", "The task to carry out")
  .option("--backend <backend>", "Backend override (anthropic, opencode, or codex)")
  .option("--provider <provider>", "Provider override (deprecated: use --backend)")
  .option("-m, --model <model>", "Model override", "auto")
  .option("--read-only", "Investigate only")
  .option("--max-steps <n>", "Max agent turns before stopping", "20")
  .option("--cwd <path>", "Working directory", process.cwd())
  .option("--resume <id>", "Resume from a checkpoint id")
  .option("--approval-mode <mode>", "off | risky | all-mutations")
  .option("--json", "Output result as JSON (includes finalText, steps, mutations)")
  .option("--plan", "Plan first (read-only), show the plan, then ask before executing")
  .option("--review", "Run a self-review pass after the task completes")
  .option("--yes", "Skip confirmation prompts (use with --plan)")
  .action(async (task, options) => {
    const cwd = path.resolve(options.cwd);
    const projectConfig = await loadProjectConfig(cwd);
    const backendName = parseBackendName(
      options.backend
        ?? options.provider
        ?? projectConfig.backend
        ?? projectConfig.provider
        ?? "codex"
    );
    if (!AGENT_BACKENDS.includes(backendName)) {
      throw new Error(
        `Backend '${backendName}' does not support agent tool use. `
        + `Choose one of: ${AGENT_BACKENDS.join(", ")}.`
      );
    }
    const checks = await checkBackend(backendName, backendRuntimeOptions(projectConfig));
    const failedCheck = checks.find((chk) => !chk.ok);
    if (failedCheck) throw new Error(`${failedCheck.name}: ${failedCheck.detail}`);
    const agent = new AgentService(createAgentBackend(backendName));
    if (
      options.approvalMode
      && !["off", "risky", "all-mutations"].includes(options.approvalMode)
    ) {
      throw new Error("--approval-mode must be off, risky, or all-mutations.");
    }

    // ── Plan mode: read-only pass first ───────────────────────────
    if (options.plan && !options.resume) {
      console.error("[plan] Investigating before executing...");
      const planResult = await agent.run({
        prompt: `You are planning how to accomplish this task. Investigate the codebase and produce a concise step-by-step plan.\n\nTask: ${task}`,
        workspaceRoot: cwd,
        model: options.model,
        readOnly: true,
        maxSteps: Math.min(Number(options.maxSteps), 10),
        onStep: (step) => console.error(`[plan turn ${step.turn}] ${step.toolsUsed.join(", ") || "done"}`),
      });
      console.error("\n── Plan ──────────────────────────────");
      console.log(planResult.finalText);
      console.error("───────────────────────────────────────\n");

      if (!options.yes) {
        console.error("Proceed with execution? (Y/n) ");
        const answer = await new Promise<string>((r) => {
          process.stdin.setEncoding("utf8");
          process.stdin.once("data", (d) => r((d as string).trim().toLowerCase()));
        });
        if (answer === "n" || answer === "no") {
          console.error("Cancelled.");
          process.exitCode = 0;
          return;
        }
      }
    }

    // ── Main agent run ────────────────────────────────────────────
    const result = await agent.run({
      prompt: task,
      workspaceRoot: cwd,
      model: options.model,
      readOnly: Boolean(options.readOnly),
      maxSteps: Number(options.maxSteps),
      resumeId: options.resume || undefined,
      approvalMode: options.approvalMode,
      onStep: (step) => console.error(`[turn ${step.turn}] ${step.toolsUsed.join(", ") || "done"}`),
    });

    // ── Output ────────────────────────────────────────────────────
    if (options.json) {
      const output: Record<string, unknown> = {
        finalText: result.finalText,
        steps: result.steps.map((s) => ({ turn: s.turn, toolsUsed: s.toolsUsed })),
        stoppedOnLimit: result.stoppedOnLimit,
        checkpointId: result.checkpointId,
        waitingForApproval: result.waitingForApproval,
      };
      const summary = result.audit.getSummary();
      if (summary.mutations > 0) {
        output.changes = summary;
        output.changesDetail = result.audit.getChanges();
      }
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(result.finalText);
    }

    if (result.waitingForApproval) {
      const waiting = result.waitingForApproval;
      console.error(
        waiting.approvalId
          ? `[waiting for approval: ${waiting.approvalId}]`
          : "[waiting for approval: Runtime unavailable]"
      );
      console.error(`Risk: ${waiting.risk} — ${waiting.reason}`);
      if (waiting.error) console.error(waiting.error);
      console.error(`Resume after the decision: oracle agent "${task}" --resume ${waiting.checkpointId}`);
    }
    if (result.stoppedOnLimit) console.error(`Stopped after ${options.maxSteps} turns.`);
    if (result.checkpointId) console.error(`[checkpoint: ${result.checkpointId}]`);

    // ── Self-review mode ──────────────────────────────────────────
    if (options.review && !result.waitingForApproval && result.steps.length > 0) {
      console.error("\n[review] Reviewing changes...");
      const reviewResult = await agent.run({
        prompt: `Review the changes made in the previous agent run. Check for:\n- Correctness bugs\n- Missing error handling\n- Security issues\n- Edge cases not handled\n- Code quality problems\n\nIf you find issues, list them with file paths and line numbers. If everything looks good, say "No issues found."\n\nTask context: ${task}`,
        workspaceRoot: cwd,
        model: options.model,
        readOnly: true,
        maxSteps: 8,
        onStep: (step) => console.error(`[review turn ${step.turn}] ${step.toolsUsed.join(", ") || "done"}`),
      });
      console.error("\n── Review ────────────────────────────");
      console.log(reviewResult.finalText);
      console.error("───────────────────────────────────────");
    }
  });

program
  .command("agent-checkpoints")
  .description("List saved agent checkpoints (for --resume)")
  .option("--json", "Output as JSON array")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (options) => {
    const oracleDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
    const { FileCheckpointStore } = await import("./agent/checkpoint.js");
    const store = new FileCheckpointStore(oracleDir);
    const list = await store.list();
    if (!list.length) { console.log("No checkpoints found."); return; }
    if (options.json) { console.log(JSON.stringify(list, null, 2)); return; }
    for (const cp of list) {
      console.log(
        `${cp.id.padEnd(50)} ${cp.updatedAt.slice(0, 19)}  ${cp.status}`
        + (cp.toolName ? `  ${cp.toolName}` : "")
        + (cp.approvalId ? `  ${cp.approvalId}` : "")
      );
    }
  });

const oracleCmd = program.command("oracle").description("Manage oracle profiles");

oracleCmd
  .command("list")
  .description("List registered oracles")
  .action(async () => {
    const reg = new OracleRegistry(homeDir());
    const list = await reg.listOracles();
    if (!list.length) { console.log("No oracles registered."); return; }
    for (const o of list) {
      const mem = o.memory ? " +memory" : "";
      console.log(`${o.name.padEnd(20)} skill=${o.skill}${mem}`);
    }
  });

oracleCmd
  .command("register")
  .description("Register a new oracle profile")
  .requiredOption("-n, --name <name>", "Oracle name")
  .requiredOption("-s, --skill <skill>", "Assigned skill")
  .option("-d, --description <text>", "Description")
  .option("-m, --model <model>", "Default model")
  .option("-p, --provider <provider>", "Default provider")
  .option("--memory", "Enable memory", false)
  .action(async (options) => {
    const reg = new OracleRegistry(homeDir());
    await reg.registerOracle({
      name: options.name,
      skill: options.skill,
      description: options.description,
      model: options.model,
      provider: options.provider,
      memory: options.memory
    });
    console.log(`Registered oracle: ${options.name}`);
  });

oracleCmd
  .command("unregister")
  .description("Remove an oracle profile")
  .argument("<name>", "Oracle name")
  .action(async (name) => {
    const reg = new OracleRegistry(homeDir());
    await reg.unregisterOracle(name);
    console.log(`Unregistered oracle: ${name}`);
  });

oracleCmd
  .command("show")
  .description("Show oracle profile details")
  .argument("<name>", "Oracle name")
  .action(async (name) => {
    const reg = new OracleRegistry(homeDir());
    const profile = await reg.getOracle(name);
    if (!profile) throw new Error(`Oracle not found: ${name}`);
    console.log(JSON.stringify(profile, null, 2));
  });

// ── memory ───────────────────────────────────────────────────────
const memCmd = program.command("memory").description("Manage oracle memory");

memCmd
  .command("list")
  .description("Show memory entries for an agent")
  .argument("[agent]", "Agent name (default: all)")
  .option("-n, --limit <number>", "Entries", "10")
  .action(async (agent, options) => {
    const orchestrator = new OrchestratorFactory(process.cwd(), homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    const entries = await memory.recall({ agent: agent ?? undefined, limit: Number(options.limit) });
    if (!entries.length) { console.log("No memory entries."); return; }
    for (const e of entries) {
      console.log(`${e.ts.slice(0, 19)}  [${e.type.padEnd(8)}]  ${e.agent.padEnd(12)}  ${e.content.slice(0, 60)}`);
    }
  });

memCmd
  .command("store")
  .description("Show or set where memory is stored (local | chatgpt | hybrid)")
  .argument("[mode]", "local, chatgpt, or hybrid; omit to show the current setting")
  .action(async (mode?: string) => {
    const root = process.cwd();
    const configPath = path.join(root, ".oracle", "config.json");

    if (!mode) {
      const config = await loadProjectConfig(root);
      const { store, remoteBackend, remoteCacheTtlMinutes, mirror } = config.memory;
      console.log(`store:          ${store}`);
      if (store !== "local") {
        console.log(`remote backend: ${remoteBackend}`);
        console.log(`remote cache:   ${remoteCacheTtlMinutes}m`);
      }
      if (store === "hybrid") {
        console.log(`mirror:         importance >= ${mirror.minImportance}, types ${mirror.types.join(", ")}${mirror.tags?.length ? `, tags ${mirror.tags.join(", ")}` : ""}`);
      }
      return;
    }

    if (mode !== "local" && mode !== "chatgpt" && mode !== "hybrid") {
      console.error(`Invalid store "${mode}". Use local, chatgpt, or hybrid.`);
      process.exitCode = 1;
      return;
    }

    // Merge into the existing file so unrelated settings survive.
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
    }
    const existingMemory = (raw.memory ?? {}) as Record<string, unknown>;
    raw.memory = { ...existingMemory, store: mode };
    await fs.writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    console.log(`Memory store set to "${mode}" in ${configPath}`);
    if (mode !== "local") {
      console.log(
        "Requires a signed-in ChatGPT session via the chatgpt-browser backend. "
        + "Saved Memory has no ids or tags, is capped at 2000 characters per entry, "
        + "and is visible account-wide."
      );
    }
  });

memCmd
  .command("clear")
  .description("Clear working memory for an agent (or all)")
  .argument("[agent]", "Agent name (omit for all)")
  .action(async (agent) => {
    const orchestrator = new OrchestratorFactory(process.cwd(), homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    const count = await memory.clearWorking(agent ?? undefined);
    console.log(`Cleared ${count} working memory entries.`);
  });

// ── memory graph ─────────────────────────────────────────────────
const graphCmd = memCmd.command("graph").description("Explore the memory entity graph");

graphCmd
  .command("rebuild")
  .description("Rebuild the entity graph from every stored memory")
  .action(async () => {
    const orchestrator = new OrchestratorFactory(process.cwd(), homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    if (!memory.graphRebuild) {
      console.error("The active memory backend does not expose an entity graph.");
      process.exitCode = 1;
      return;
    }

    // Indexing is incremental, so entities extracted under older rules persist
    // until their memory is rewritten. This is what applies an extractor change
    // to memories already on disk.
    const before = await memory.getGraphStats?.();
    const result = await memory.graphRebuild();
    if (before) {
      console.log(`before:  ${before.entityCount} entities, ${before.edgeCount} edges`);
    }
    console.log(`rebuilt: ${result.entityCount} entities, ${result.edgeCount} edges`);
    console.log(`from ${result.memoriesIndexed} memories.`);
  });

graphCmd
  .command("show")
  .description("Show entity graph overview")
  .option("-n, --limit <number>", "Max entities", "20")
  .option("--connected", "Hide entities with no relations", false)
  .action(async (options) => {
    const orchestrator = new OrchestratorFactory(process.cwd(), homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    if (!memory.getGraphView) {
      console.error("The active memory backend does not expose an entity graph.");
      process.exitCode = 1;
      return;
    }
    const view = await memory.getGraphView({
      limit: Number(options.limit),
      includeIsolated: !options.connected,
    });

    if (!view.nodes.length) {
      console.log("Graph is empty — remember something first.");
      return;
    }

    console.log(`Entities: ${view.stats.totalEntities}   Edges: ${view.stats.totalEdges}`);
    if (view.stats.truncated) {
      console.log(`Showing top ${view.stats.renderedEntities} by connectedness.\n`);
    } else {
      console.log("");
    }

    for (const node of view.nodes) {
      const mem = `${node.memoryCount} ${node.memoryCount === 1 ? "memory" : "memories"}`;
      console.log(`  ${node.label.padEnd(24)} ${node.type.padEnd(12)} ${String(node.degree).padStart(3)} edges  ${mem}`);
    }
  });

graphCmd
  .command("entity")
  .description("Show one entity's relations and memories")
  .argument("<name>", "Entity name")
  .action(async (name) => {
    const orchestrator = new OrchestratorFactory(process.cwd(), homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    if (!memory.getGraphEntity) {
      console.error("The active memory backend does not expose an entity graph.");
      process.exitCode = 1;
      return;
    }
    const detail = await memory.getGraphEntity(name);

    if (!detail) {
      console.log(`Entity not found: ${name}. Try \`oracle memory graph show\`.`);
      process.exitCode = 1;
      return;
    }

    console.log(`${detail.name}  [${detail.type}]`);
    if (detail.aliases.length) console.log(`  aliases: ${detail.aliases.join(", ")}`);
    console.log(`  first seen: ${detail.firstSeen.slice(0, 19)}`);
    console.log(`  last seen:  ${detail.lastSeen.slice(0, 19)}`);

    if (detail.relations.length) {
      console.log("\n  Relations:");
      for (const rel of detail.relations) {
        const arrow = rel.direction === "out" ? "→" : "←";
        console.log(`    ${arrow} ${rel.relation.padEnd(16)} ${rel.other}  (${rel.weight})`);
      }
    } else {
      console.log("\n  No relations recorded.");
    }

    console.log(`\n  Memories (${detail.memoryIds.length}):`);
    for (const id of detail.memoryIds.slice(0, 10)) console.log(`    ${id}`);
    if (detail.memoryIds.length > 10) {
      console.log(`    … and ${detail.memoryIds.length - 10} more`);
    }
  });

graphCmd
  .command("path")
  .description("Find the shortest relation path between two entities")
  .argument("<from>", "Start entity")
  .argument("<to>", "End entity")
  .action(async (from, to) => {
    const orchestrator = new OrchestratorFactory(process.cwd(), homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    if (!memory.graphFindPath) {
      console.error("The active memory backend does not expose an entity graph.");
      process.exitCode = 1;
      return;
    }
    const hops = await memory.graphFindPath(from, to);

    if (!hops.length) {
      console.log(`No path found between "${from}" and "${to}".`);
      process.exitCode = 1;
      return;
    }

    console.log(`Path (${hops.length} ${hops.length === 1 ? "hop" : "hops"}):`);
    for (const hop of hops) console.log(`  ${hop.from} --[${hop.relation}]--> ${hop.to}`);
  });

// ── usage ────────────────────────────────────────────────────────
const usageCmd = program.command("usage").description("Token and cost accounting across provider calls");

async function withCostTracker<T>(fn: (tracker: import("./runtime/costTracker.js").CostTracker) => T): Promise<T> {
  const [{ RuntimeDatabase }, { CostTracker }] = await Promise.all([
    import("./runtime/database.js"),
    import("./runtime/costTracker.js"),
  ]);
  const database = new RuntimeDatabase(homeDir());
  try {
    return fn(new CostTracker(database.connection));
  } finally {
    database.close();
  }
}

function printCostSummary(summary: import("./runtime/costTracker.js").CostSummary): void {
  if (!summary.calls) {
    console.log(`No recorded calls for: ${summary.window}`);
    return;
  }

  const usd = (n: number) => `$${n.toFixed(4)}`;
  console.log(`${summary.window}: ${summary.totalTokens.toLocaleString()} tokens  ${usd(summary.totalCostUSD)}  (${summary.calls} calls, avg ${usd(summary.avgCostPerCall)})`);

  const section = (title: string, rows: Record<string, { tokens: number; costUSD: number; calls: number }>) => {
    const entries = Object.entries(rows).sort((a, b) => b[1].costUSD - a[1].costUSD);
    if (!entries.length) return;
    console.log(`\n  ${title}`);
    for (const [key, value] of entries) {
      console.log(`    ${key.padEnd(20)} ${String(value.tokens).padStart(10)} tokens  ${usd(value.costUSD).padStart(10)}  ${value.calls} calls`);
    }
  };

  section("By provider", summary.byProvider);
  section("By agent", summary.byAgent);

  // Cost is 0 for models absent from the price table; say so rather than
  // letting a $0.0000 total read as "this was free".
  if (summary.totalCostUSD === 0) {
    console.log("\n  Cost is $0 — the models used are local or absent from the price table.");
  }
}

usageCmd
  .command("show", { isDefault: true })
  .description("Show token usage and cost")
  .argument("[window]", "today | week | month | all", "today")
  .option("--agent <name>", "Restrict to one agent")
  .action(async (window, options) => {
    const valid = ["today", "week", "month", "all"];
    if (!valid.includes(window)) {
      console.error(`Unknown window: ${window}. Expected ${valid.join(", ")}.`);
      process.exitCode = 1;
      return;
    }
    const summary = await withCostTracker((t) => t.summary(window, { agent: options.agent }));
    printCostSummary(summary);
  });

usageCmd
  .command("budget")
  .description("Check spend against a budget ceiling")
  .argument("<limit>", "Budget in USD")
  .option("-w, --window <window>", "today | week | month | all", "today")
  .action(async (limit, options) => {
    const limitUSD = Number(limit);
    if (!Number.isFinite(limitUSD) || limitUSD <= 0) {
      console.error(`Invalid budget: ${limit}. Expected a positive number.`);
      process.exitCode = 1;
      return;
    }
    const result = await withCostTracker((t) => t.checkBudget(limitUSD, options.window));
    console.log(result.message);
    if (result.level === "exceeded") process.exitCode = 1;
  });

usageCmd
  .command("prune")
  .description("Delete cost records older than the retention window")
  .option("-d, --days <number>", "Retention in days", "90")
  .action(async (options) => {
    const removed = await withCostTracker((t) => t.prune(Number(options.days)));
    console.log(`Removed ${removed} cost record(s) older than ${options.days} days.`);
  });

// ── models ───────────────────────────────────────────────────────
program
  .command("models")
  .description("List models by provider and show which are usable now")
  .action(async () => {
    const { PROVIDER_MODELS, detectAvailableProviders } = await import("./providers/factory.js");
    const available = new Set(detectAvailableProviders());

    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      // `codex` depends on CLI login state, which env detection cannot see.
      const status = provider === "codex"
        ? "run `oracle doctor` to check"
        : available.has(provider as never)
          ? "available"
          : "no credentials";
      console.log(`${provider.padEnd(12)} (${status})`);
      for (const model of models) console.log(`  ${model}`);
    }
  });

const wikiCmd = program.command("wiki").description("Compile facts/insights into a topic-grouped memory wiki");

wikiCmd
  .command("build")
  .description("Compile all facts/insights into .oracle/wiki/<topic>.md + an index")
  .action(async () => {
    const cwd = process.cwd();
    const orchestrator = new OrchestratorFactory(cwd, homeDir());
    const memory = await orchestrator.createMemoryAdapter();
    const result = await buildWiki(memory, cwd);
    console.log(`Compiled ${result.topics.length} topic(s) → ${result.path}`);
  });

wikiCmd
  .command("list")
  .description("List compiled wiki topics")
  .action(async () => {
    const topics = await listWikiTopics(process.cwd());
    if (!topics.length) { console.log("No wiki topics yet — run `oracle wiki build` first."); return; }
    for (const t of topics) console.log(t);
  });

wikiCmd
  .command("show")
  .description("Print a compiled wiki topic page")
  .argument("<topic>", "Topic name")
  .action(async (topic) => {
    const page = await getWikiPage(process.cwd(), topic);
    if (!page) { console.log(`Topic not found: ${topic}. Run \`oracle wiki build\` or \`oracle wiki list\`.`); process.exitCode = 1; return; }
    console.log(page);
  });

// ── docs ─────────────────────────────────────────────────────────
const docsCmd = program.command("docs").description("Manage .oracle/docs/ knowledge base");

docsCmd
  .command("list")
  .description("List files in .oracle/docs/")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (options) => {
    const docs = await listDocs(path.resolve(options.cwd));
    if (!docs.length) { console.log("No docs found in .oracle/docs/."); return; }
    for (const d of docs) {
      console.log(`${d.name.padEnd(40)} ${(d.size / 1024).toFixed(1)}KB`);
    }
  });

docsCmd
  .command("search")
  .description("BM25-ranked passage search over .oracle/docs/")
  .argument("<query>", "Search query")
  .option("-n, --limit <number>", "Max results", "10")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (query, options) => {
    const results = await searchDocs(path.resolve(options.cwd), query, Number(options.limit));
    if (!results.length) { console.log("No matches."); return; }
    for (const r of results) {
      console.log(`${r.name}${r.heading ? ` — ${r.heading}` : ""}  (score ${r.score.toFixed(2)})`);
      console.log(`  ${r.snippet.slice(0, 150).replace(/\n/g, " ")}...`);
    }
  });

docsCmd
  .command("add")
  .description("Add or overwrite a file in .oracle/docs/")
  .argument("<name>", "Relative filename, e.g. 'auth/oauth.md'")
  .requiredOption("-f, --file <path>", "Source file to copy content from")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (name, options) => {
    const content = await fs.readFile(options.file, "utf8");
    const filePath = await addDoc(path.resolve(options.cwd), name, content);
    console.log(`Added ${filePath}`);
  });

docsCmd
  .command("remove")
  .description("Delete a file from .oracle/docs/")
  .argument("<name>", "Relative filename")
  .option("--cwd <path>", "Working directory", process.cwd())
  .action(async (name, options) => {
    const removed = await removeDoc(path.resolve(options.cwd), name);
    console.log(removed ? `Removed ${name}` : `Not found: ${name}`);
  });

// ── web ──────────────────────────────────────────────────────────
const webCmd = program.command("web").description("Web search, fetch, and extract (Brave/Tavily/Firecrawl/AgentQL)");

webCmd
  .command("search")
  .description("Search the web — uses the first provider with a configured API key unless --provider is given")
  .argument("<query>", "Search query")
  .option("-n, --limit <number>", "Max results", "5")
  .option("--provider <provider>", "brave | tavily | firecrawl")
  .option("--trace", "Print the provider routing/fallback chain")
  .action(async (query, options) => {
    const outcome = await webSearchWithTrace(query, Number(options.limit), options.provider);
    if (options.trace) {
      for (const a of outcome.attempts) {
        console.error(`[${a.provider}] ${a.reason} → ${a.outcome} (${a.latencyMs}ms)${a.errorMessage ? `: ${a.errorMessage}` : ""}`);
      }
    }
    if (!outcome.results.length) { console.log("No results."); return; }
    for (const r of outcome.results) {
      console.log(`${r.title}\n  ${r.url}\n  ${r.description}\n`);
    }
  });

webCmd
  .command("fetch")
  .description("Fetch a URL and print its readable text")
  .argument("<url>", "URL to fetch")
  .option("--provider <provider>", "native | firecrawl", "native")
  .action(async (url, options) => {
    const page = await fetchUrl(url, options.provider);
    if (page.title) console.log(`# ${page.title}\n`);
    console.log(page.text);
  });

webCmd
  .command("extract")
  .description("Extract structured data from a URL via TinyFish's AgentQL API")
  .argument("<url>", "URL to extract from")
  .argument("<prompt>", "What to extract, e.g. 'the product name and price'")
  .action(async (url, prompt) => {
    const result = await agentqlExtract(url, prompt);
    console.log(JSON.stringify(result.data, null, 2));
    console.error(`\nSource: ${result.sourceUrl}`);
  });

// ── browser ──────────────────────────────────────────────────────────
const browserCmd = program
  .command("browser")
  .description("Manage ChatGPT Browser Mode (experimental)");

browserCmd
  .command("setup")
  .description("Initialize Chrome profile for Oracle ChatGPT session and open ChatGPT for login")
  .action(async () => {
    const projectConfig = await loadProjectConfig(process.cwd());
    const runtimeOptions = backendRuntimeOptions(projectConfig);
    const profileDir = runtimeOptions.browser.profileDir;
    await fs.mkdir(profileDir, { recursive: true });
    const { openChatGptInOracleChrome } = await import("./backends/chatgpt-browser/chrome.js");
    console.log(`Launching Chrome with Oracle profile at: ${profileDir}`);
    console.log("Please log into your ChatGPT account in the browser window.");
    await openChatGptInOracleChrome({
      profileDir,
      enabled: true,
      headed: true,
      timeoutMs: runtimeOptions.browser.timeoutMs
    });
  });

browserCmd
  .command("login")
  .description("Open the isolated Oracle profile without automation flags for manual ChatGPT login")
  .action(async () => {
    const projectConfig = await loadProjectConfig(process.cwd());
    const runtimeOptions = backendRuntimeOptions(projectConfig);
    const profileDir = runtimeOptions.browser.profileDir;
    const { openChatGptForManualLogin } = await import(
      "./backends/chatgpt-browser/chrome.js"
    );
    console.log("Restarting the dedicated Oracle Chrome profile in manual login mode...");
    await openChatGptForManualLogin({
      profileDir,
      enabled: true,
      headed: true,
      timeoutMs: runtimeOptions.browser.timeoutMs
    });
    console.log("Complete ChatGPT login, then CLOSE this Chrome window.");
    console.log("After it closes, run `oracle browser status --live` to verify the saved session.");
  });

browserCmd
  .command("status")
  .description("Check ChatGPT Browser Mode status and diagnostics")
  .option("--live", "Open or reuse Oracle Chrome and verify the authenticated ChatGPT session")
  .option("--selectors", "Check that the ChatGPT DOM handles Browser Mode depends on still resolve")
  .action(async (options) => {
    const projectConfig = await loadProjectConfig(process.cwd());
    const runtimeOptions = backendRuntimeOptions(projectConfig);
    const checks = await checkBackend("chatgpt-browser", runtimeOptions);
    if (options.live) {
      const { checkLiveChatGptAuthentication } = await import(
        "./backends/chatgpt-browser/diagnostics.js"
      );
      checks.push(await checkLiveChatGptAuthentication({
        profileDir: runtimeOptions.browser.profileDir,
        enabled: projectConfig.experimental?.browserMode ?? false,
        headed: true,
        timeoutMs: runtimeOptions.browser.timeoutMs
      }));
    }
    if (options.selectors) {
      // The DOM is not an API: a UI change breaks Browser Mode at the moment a
      // user runs it, with a timeout that says nothing about the cause.
      const { checkChatGptSelectors } = await import(
        "./backends/chatgpt-browser/diagnostics.js"
      );
      checks.push(...await checkChatGptSelectors({
        profileDir: runtimeOptions.browser.profileDir,
        enabled: projectConfig.experimental?.browserMode ?? false,
        headed: true,
        timeoutMs: runtimeOptions.browser.timeoutMs
      }));
    }
    console.log("ChatGPT Browser Mode Status:");
    for (const check of checks) {
      console.log(`  ${check.ok ? "[OK]" : "[FAIL]"} ${check.name}: ${check.detail}`);
    }
  });

browserCmd
  .command("stop")
  .description("Close the Oracle Chrome profile left running for Browser Mode")
  .action(async () => {
    const projectConfig = await loadProjectConfig(process.cwd());
    const runtimeOptions = backendRuntimeOptions(projectConfig);
    const profileDir = runtimeOptions.browser.profileDir;
    const { closeActiveOracleChrome } = await import("./backends/chatgpt-browser/chrome.js");

    // Browser Mode deliberately leaves Chrome running so consecutive consults
    // reuse one session. On a machine short on memory that is worth reclaiming
    // between runs; the profile — and the login in it — stays on disk.
    const closed = await closeActiveOracleChrome(profileDir);
    console.log(
      closed
        ? `Closed the Oracle Chrome profile at ${profileDir}. Your ChatGPT login is kept.`
        : "No Oracle Chrome instance is running."
    );
  });

browserCmd
  .command("open")
  .description("Open ChatGPT in Chrome with Oracle profile")
  .action(async () => {
    const projectConfig = await loadProjectConfig(process.cwd());
    const runtimeOptions = backendRuntimeOptions(projectConfig);
    const profileDir = runtimeOptions.browser.profileDir;
    await fs.mkdir(profileDir, { recursive: true });
    const { openChatGptInOracleChrome } = await import("./backends/chatgpt-browser/chrome.js");
    console.log(`Opening ChatGPT in Chrome profile...`);
    await openChatGptInOracleChrome({
      profileDir,
      enabled: true,
      headed: true,
      timeoutMs: runtimeOptions.browser.timeoutMs
    });
  });

// ── existing commands ────────────────────────────────────────────
program
  .command("serve")
  .description("Run the signed-in browser as a remote Oracle service")
  .option("--host <address>", "Interface to bind")
  .option("--port <number>", "TCP port")
  .option("--token <value>", "Access token (prefer ORACLE_SERVE_TOKEN)")
  .option("--manual-login", "Use a persistent manual-login Chrome profile")
  .option("--no-manual-login", "Use browser cookie sync instead of manual login")
  .option("--profile-dir <path>", "Persistent manual-login Chrome profile directory")
  .option("--print-command", "Print the redacted upstream command without starting it")
  .option("--cwd <path>", "Project configuration root", process.cwd())
  .action(async (options) => {
    const cwd = path.resolve(options.cwd);
    const config = await loadProjectConfig(cwd);
    const port = Number(options.port ?? config.serve.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("--port must be an integer between 1 and 65535.");
    }
    const serviceOptions = {
      host: options.host ?? config.serve.host,
      port,
      token: options.token ?? process.env.ORACLE_SERVE_TOKEN,
      manualLogin: options.manualLogin ?? config.serve.manualLogin,
      profileDir: options.profileDir ?? config.serve.profileDir,
      cwd,
    };
    const invocation = buildBrowserServiceInvocation(serviceOptions, {
      platform: process.platform,
      execPath: process.execPath,
      appData: process.env.APPDATA,
    });
    if (options.printCommand) {
      console.log(formatBrowserServiceInvocation(invocation));
      return;
    }
    console.log(
      `Starting browser service at ${serviceOptions.host}:${serviceOptions.port} ` +
        `(${serviceOptions.manualLogin ? "manual-login profile" : "cookie sync"}).`
    );
    process.exitCode = await runBrowserService(serviceOptions);
  });

program
  .command("doctor")
  .option("--backend <backend>", "Backend to check")
  .option("--provider <provider>", "Provider (deprecated): use --backend instead")
  .action(async (options) => {
    const projectConfig = await loadProjectConfig(process.cwd());
    const backendName = parseBackendName(
      options.backend
        ?? options.provider
        ?? projectConfig.backend
        ?? projectConfig.provider
        ?? "codex"
    );
    const checks = await checkBackend(backendName, backendRuntimeOptions(projectConfig));
    for (const check of checks) {
      console.log(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}`);
    }
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
  });

program
  .command("setup-mcp")
  .option("--client <client>", "Client: claude-code or codex", "claude-code")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--print", "Print generated configuration without writing")
  .option("--force", "Replace an existing configuration")
  .action(async (options) => {
    if (options.client !== "claude-code" && options.client !== "codex") {
      throw new Error("Expected --client claude-code or codex.");
    }
    const serverPath = fileURLToPath(new URL("./mcp.js", import.meta.url));
    const file = generateMcpSetup({
      root: path.resolve(options.cwd),
      client: options.client as McpClient,
      serverPath
    });
    if (options.print) {
      console.log(file.content.trimEnd());
      return;
    }
    const projectConfigPath = await ensureProjectConfig(path.resolve(options.cwd));
    await writeMcpSetup(file, options.force);
    console.log(`Created ${projectConfigPath}`);
    console.log(`Created ${file.path}`);
  });

program
  .command("session")
  .argument("<id>", "Session id")
  .action(async (id) => {
    const record = await new FileSessionStore().read(id);
    if (!record) {
      console.error(`Session not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(record, null, 2));
  });

program
  .command("status")
  .option("-n, --limit <number>", "Number of sessions", "20")
  .action(async (options) => {
    const records = await new FileSessionStore().list(Number(options.limit));
    for (const item of records) {
      console.log(
        `${item.createdAt}  ${item.status.padEnd(9)}  ${item.model.padEnd(16)}  ${item.sessionId}`
      );
    }
  });

program
  .command("login")
  .description("Authenticate with an OAuth provider")
  .option("--provider <provider>", "Provider", "anthropic")
  .option("--client-id <id>", "OAuth client ID")
  .option("--force", "Re-authenticate")
  .option("--status", "Show the current session without logging in")
  .action(async (options) => {
    const store = new TokenStore(homeDir());

    if (options.status) {
      if (options.provider !== "anthropic") {
        console.log(`No OAuth session tracked for provider: ${options.provider}`);
        return;
      }
      const { readAnthropicOAuthSession } = await import("./providers/factory.js");
      const session = await readAnthropicOAuthSession(homeDir());
      if (!session.present) {
        console.log("Not logged in. Run `oracle login --provider anthropic`.");
        process.exitCode = 1;
        return;
      }
      console.log(`Provider: anthropic`);
      console.log(`Plan:     ${session.planTier ?? "api"}`);
      console.log(
        session.expired
          ? session.refreshable
            ? "Status:   expired, refreshes on next use"
            : "Status:   expired, re-login required"
          : "Status:   active"
      );
      if (process.env.ANTHROPIC_API_KEY) {
        // The provider prefers the key, so say so — otherwise a stale session
        // looks like the thing serving your calls when it is not.
        console.log("Note:     ANTHROPIC_API_KEY is set and takes precedence over this session.");
      }
      if (session.expired && !session.refreshable) process.exitCode = 1;
      return;
    }

    const existing = await store.read(options.provider);
    if (existing && !options.force) {
      console.log(`Already logged in to ${options.provider}. Use --force to re-authenticate.`);
      return;
    }
    if (options.provider !== "anthropic") throw new Error(`Login not supported for provider: ${options.provider}`);
    const clientId = options.clientId ?? process.env.ANTHROPIC_CLIENT_ID ?? existing?.clientId;
    if (!clientId) throw new Error("ANTHROPIC_CLIENT_ID is required (or pass --client-id).");
    const oauth = new AnthropicOAuthClient(clientId, store);
    const session = await oauth.startDeviceFlow();
    console.log(`\nOpen: ${session.verificationUri}\nCode: ${session.userCode}\n`);
    console.log("Waiting for authorization...");
    await oauth.pollForToken(session.deviceCode, session.interval);
    const tier = await oauth.getPlanTier();
    console.log(`Authenticated. Plan: ${tier}`);
  });

program
  .command("logout")
  .description("Clear OAuth session")
  .option("--provider <provider>", "Provider", "anthropic")
  .action(async (options) => {
    await new TokenStore(homeDir()).delete(options.provider);
    console.log(`Logged out of ${options.provider}.`);
  });

program
  .command("skill")
  .description("Manage skills")
  .argument("[action]", "list, install", "list")
  .argument("[arg]", "Skill name or file path")
  .action(async (action, arg) => {
    const reg = new SkillRegistry(homeDir());
    await reg.load();
    if (action === "list") {
      for (const skill of reg.list()) {
        console.log(`${skill.name.padEnd(20)} ${skill.description}`);
      }
    } else if (action === "install") {
      if (!arg) throw new Error("Usage: oracle skill install <file.json>");
      const name = await reg.install(arg);
      console.log(`Installed skill: ${name}`);
    } else {
      throw new Error(`Unknown action: ${action}. Use list or install.`);
    }
  });

// ── inter-agent messaging ───────────────────────────────────────
const msgCmd = program
  .command("msg")
  .description("Inter-agent message bus (shared ~/.oracle/messages)")
  .addHelpText(
    "after",
    "\nFlow, wake-up hooks, and setup: .claude/skills/oracle-messaging/SKILL.md in the Oracle repo."
  );

function printMessage(m: import("./messaging/store.js").AgentMessage): void {
  console.log(`${m.id} | ${m.ts} | from ${m.from} to ${m.to}${m.subject ? ` | ${m.subject}` : ""}`);
  console.log(`  ${m.body.split("\n").join("\n  ")}`);
}

msgCmd
  .command("send")
  .description("Send a message to another agent ('*' broadcasts)")
  .requiredOption("-f, --from <agent>", "Your agent name")
  .requiredOption("-t, --to <agent>", "Recipient agent name, or '*'")
  .option("-b, --body <text>", "Message body ('-' reads stdin)")
  .option("--body-file <path>", "Read the body from a file (safer for long/multiline text)")
  .option("-s, --subject <text>", "Subject line")
  .option("--reply-to <id>", "Message id this replies to")
  .option("--ack", "Also mark the replied-to message as read (requires --reply-to)", false)
  .action(async (options) => {
    let body: string | undefined = options.body;
    if (options.bodyFile) {
      body = await fs.readFile(path.resolve(options.bodyFile), "utf8");
    } else if (body === "-") {
      body = await new Promise<string>((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => resolve(data));
      });
    }
    if (!body?.trim()) throw new Error("Provide a body via -b, --body-file, or -b - (stdin).");
    const store = new MessageStore(homeDir());
    const msg = await store.send({
      from: options.from,
      to: options.to,
      body,
      subject: options.subject,
      replyTo: options.replyTo
    });
    if (options.ack && options.replyTo) {
      await store.ack(options.from, [options.replyTo]);
      console.log(`Sent ${msg.id} to ${msg.to} (acked ${options.replyTo})`);
    } else {
      console.log(`Sent ${msg.id} to ${msg.to}`);
    }
  });

msgCmd
  .command("inbox")
  .description("Show messages addressed to you (unread by default)")
  .requiredOption("-a, --agent <name>", "Your agent name")
  .option("--all", "Include already-read messages", false)
  .option("--limit <n>", "Max messages", "50")
  .option("--json", "Output a JSON array (empty array when inbox is empty)", false)
  .option("--wait", "If empty, block until a message arrives or --timeout expires", false)
  .option("--timeout <seconds>", "Max seconds to --wait", "120")
  .action(async (options) => {
    const store = new MessageStore(homeDir());
    let inbox = await store.inbox(options.agent, {
      unreadOnly: !options.all,
      limit: Number(options.limit)
    });

    if (!inbox.length && options.wait) {
      const { watchInbox } = await import("./messaging/watch.js");
      const timeoutMs = Number(options.timeout) * 1000;
      const arrived = await new Promise<boolean>((resolve) => {
        let watcher: import("chokidar").FSWatcher | undefined;
        const timer = setTimeout(() => { void watcher?.close(); resolve(false); }, timeoutMs);
        void watchInbox(homeDir(), options.agent, () => {
          clearTimeout(timer);
          void watcher?.close();
          resolve(true);
        }).then((w) => { watcher = w; });
      });
      if (arrived) {
        inbox = await store.inbox(options.agent, { unreadOnly: !options.all, limit: Number(options.limit) });
      }
    }

    if (options.json) { console.log(JSON.stringify(inbox, null, 2)); return; }
    if (!inbox.length) { console.log("Inbox empty."); return; }
    for (const m of inbox) printMessage(m);
  });

msgCmd
  .command("ack")
  .description("Mark messages as read")
  .requiredOption("-a, --agent <name>", "Your agent name")
  .option("--all", "Ack every unread message", false)
  .argument("[ids...]", "Message ids to acknowledge")
  .action(async (ids, options) => {
    const store = new MessageStore(homeDir());
    if (options.all) {
      const acked = await store.ackAll(options.agent);
      console.log(`Acked ${acked.length} message(s).`);
      return;
    }
    if (!ids.length) throw new Error("Provide message ids or --all.");
    const acked = await store.ack(options.agent, ids);
    console.log(`Acked ${acked.length}/${ids.length}.`);
  });

msgCmd
  .command("status")
  .description("Show one message including who has read it")
  .argument("<id>", "Message id")
  .action(async (id) => {
    const store = new MessageStore(homeDir());
    const msg = await store.get(id);
    if (!msg) { console.log(`Not found: ${id}`); process.exitCode = 1; return; }
    printMessage(msg);
    console.log(`  readBy: ${msg.readBy.length ? msg.readBy.join(", ") : "(no one yet)"}`);
  });

msgCmd
  .command("watch")
  .description("Watch for incoming messages in real time; optionally run a command per message")
  .requiredOption("-a, --agent <name>", "Your agent name")
  .option(
    "--exec <command>",
    "Shell command to run per message (message fields exposed as ORACLE_MSG_ID/FROM/TO/SUBJECT/BODY env vars)"
  )
  .action(async (options) => {
    const { watchInbox } = await import("./messaging/watch.js");
    const { spawn } = await import("node:child_process");
    await watchInbox(homeDir(), options.agent, (msg) => {
      console.log(`[${msg.ts}] ${msg.id} | from ${msg.from}${msg.subject ? ` | ${msg.subject}` : ""}`);
      console.log(`  ${msg.body.split("\n").join("\n  ")}`);
      if (options.exec) {
        const child = spawn(options.exec, {
          shell: true,
          stdio: "inherit",
          env: {
            ...process.env,
            ORACLE_MSG_ID: msg.id,
            ORACLE_MSG_FROM: msg.from,
            ORACLE_MSG_TO: msg.to,
            ORACLE_MSG_SUBJECT: msg.subject ?? "",
            ORACLE_MSG_BODY: msg.body
          }
        });
        child.on("error", (err) => console.error(`exec failed: ${err.message}`));
      }
    });
    console.log(`Watching messages for "${options.agent}" — Ctrl+C to stop.`);
    // keep the process alive until interrupted
    await new Promise(() => {});
  });

// ── task planning & tracking ────────────────────────────────────
const taskCmd = program
  .command("task")
  .description("Plan, assign, track, and verify work between agents (builds on the msg bus)")
  .addHelpText(
    "after",
    "\nFlow: create (assigns + messages assignee) -> update (progress notes) -> checklist (verify) -> submit (blocks on unchecked items, notifies creator) -> close (approve or bounce back)."
  );

function printTask(t: import("./tasks/store.js").TaskRecord): void {
  const checklist = t.checklist.length
    ? "\n  " + t.checklist.map((c, i) => `${i}: [${c.done ? "x" : " "}] ${c.text}`).join("\n  ")
    : "";
  console.log(`${t.id} | ${t.status} | ${t.title} | ${t.createdBy} -> ${t.assignee}${checklist}`);
  if (t.workflowId) console.log(`  workflow: ${t.workflowId}`);
  if (t.messageIds.length) console.log(`  messages: ${t.messageIds.join(", ")}`);
}

function makeCoordination(includeSwarms: boolean = false): CoordinationService {
  const root = homeDir();
  return new CoordinationService(
    new TaskStore(root),
    new MessageStore(root),
    includeSwarms ? new SwarmStore(root) : undefined
  );
}

taskCmd
  .command("create")
  .description("Create and assign a task; messages the assignee")
  .requiredOption("--title <text>", "Task title")
  .option("--description <text>", "Task description")
  .requiredOption("--created-by <agent>", "Your agent name (reviews/closes this task)")
  .requiredOption("--assignee <agent>", "Agent responsible for the work")
  .option("--checklist <items...>", "Verification steps required before submit")
  .option("--parent <id>", "Parent task id")
  .action(async (options) => {
    const task = await makeCoordination().createTask({
      title: options.title,
      description: options.description,
      createdBy: options.createdBy,
      assignee: options.assignee,
      checklist: options.checklist,
      parentId: options.parent
    });
    console.log(`Created ${task.id}, assigned to ${task.assignee}.`);
  });

taskCmd
  .command("list")
  .description("List tasks, optionally filtered")
  .option("--assignee <agent>")
  .option("--created-by <agent>")
  .option("--status <status>")
  .option("--active", "Only pending/in_progress/review/blocked", false)
  .action(async (options) => {
    const tasks = new TaskStore(homeDir());
    const list = await tasks.list({
      assignee: options.assignee,
      createdBy: options.createdBy,
      status: options.status,
      activeOnly: options.active
    });
    if (!list.length) { console.log("No tasks found."); return; }
    for (const t of list) printTask(t);
  });

taskCmd
  .command("get")
  .description("Show full task detail: checklist + note history")
  .argument("<id>", "Task id")
  .action(async (id) => {
    const tasks = new TaskStore(homeDir());
    const task = await tasks.get(id);
    if (!task) { console.log(`Not found: ${id}`); process.exitCode = 1; return; }
    printTask(task);
    for (const n of task.notes) console.log(`  [${n.ts}] ${n.agent}: ${n.text}`);
  });

taskCmd
  .command("update")
  .description("Record progress: a note and/or a status change")
  .argument("<id>", "Task id")
  .requiredOption("-a, --agent <name>", "Your agent name")
  .option("--note <text>", "Progress note")
  .option("--status <status>", "pending|in_progress|review|done|blocked|cancelled")
  .action(async (id, options) => {
    const tasks = new TaskStore(homeDir());
    const task = await tasks.update(id, options.agent, { note: options.note, status: options.status });
    if (!task) { console.log(`Not found: ${id}`); process.exitCode = 1; return; }
    console.log(`Updated ${id}.`);
  });

taskCmd
  .command("check")
  .description("Check off (or uncheck) a verification checklist item by index")
  .argument("<id>", "Task id")
  .argument("<index>", "0-based checklist index")
  .option("--undo", "Uncheck instead of check", false)
  .action(async (id, index, options) => {
    const tasks = new TaskStore(homeDir());
    const task = await tasks.setChecklistItem(id, Number(index), !options.undo);
    if (!task) { console.log(`Not found: ${id}[${index}]`); process.exitCode = 1; return; }
    printTask(task);
  });

taskCmd
  .command("submit")
  .description("Submit for review — blocks if any checklist item is unchecked; notifies the creator on success")
  .argument("<id>", "Task id")
  .requiredOption("-a, --agent <name>", "Your agent name")
  .requiredOption("--summary <text>", "What you did, for the reviewer")
  .action(async (id, options) => {
    try {
      const task = await makeCoordination().submitTask(id, options.agent, options.summary);
      console.log(`Submitted ${id} for review; ${task.createdBy} notified.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

taskCmd
  .command("close")
  .description("Approve (done) or reject (bounces to in_progress) a submitted task; notifies the assignee")
  .argument("<id>", "Task id")
  .requiredOption("-a, --agent <name>", "Your agent name (the reviewer)")
  .option("--reject", "Reject instead of approve", false)
  .option("--note <text>", "Reason, especially when rejecting")
  .action(async (id, options) => {
    const approved = !options.reject;
    await makeCoordination().closeTask(id, options.agent, approved, options.note);
    console.log(approved ? `Closed ${id} as done.` : `Sent ${id} back to in_progress.`);
  });

// ── runtime daemon ──────────────────────────────────────────────
async function runDaemonForeground(
  host: string,
  port: number,
  allowRemote = false
): Promise<void> {
  const { OracleDaemon } = await import("./runtime/daemon.js");
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const daemon = new OracleDaemon({
    homeDir: homeDir(),
    host,
    port,
    allowRemote,
    workspaceRoot: process.cwd(),
    onShutdown: resolveStopped
  });
  const state = await daemon.start();
  console.error(`Oracle Runtime ${VERSION} listening on http://${state.host}:${state.port}`);
  console.error(`SQLite: ${state.databasePath}`);

  const shutdown = async () => {
    await daemon.stop();
    resolveStopped();
  };
  const onSigint = () => void shutdown();
  const onSigterm = () => void shutdown();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  await stopped;
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

const daemonCmd = program
  .command("daemon")
  .description("Manage the persistent Oracle Runtime service");

daemonCmd
  .command("start")
  .description("Start Oracle Runtime in the background")
  .option("--host <host>", "Bind host", "127.0.0.1")
  .option("--port <port>", "Local API port", "4777")
  .option("--remote", "Allow an explicit non-loopback binding for Remote Swarm", false)
  .action(async (options) => {
    const result = await startDaemon({
      homeDir: homeDir(),
      host: options.host,
      port: Number(options.port),
      allowRemote: Boolean(options.remote),
      workspaceRoot: process.cwd()
    });
    console.log(result.alreadyRunning ? "Oracle Runtime is already running." : "Oracle Runtime started.");
    console.log(`  pid:     ${result.state.pid}`);
    console.log(`  API:     http://${result.state.host}:${result.state.port}`);
    console.log(`  SQLite:  ${result.state.databasePath}`);
  });

daemonCmd
  .command("run")
  .description("Run Oracle Runtime in the foreground")
  .option("--host <host>", "Bind host", "127.0.0.1")
  .option("--port <port>", "Local API port", "4777")
  .option("--remote", "Allow an explicit non-loopback binding for Remote Swarm", false)
  .action(async (options) => {
    await runDaemonForeground(options.host, Number(options.port), Boolean(options.remote));
  });

daemonCmd
  .command("status")
  .description("Show daemon, scheduler, API, and storage status")
  .option("--json", "Print machine-readable status", false)
  .action(async (options) => {
    const status = await daemonStatus(homeDir());
    const safeState = status.state ? { ...status.state, token: undefined } : undefined;
    if (options.json) {
      console.log(JSON.stringify({ ...status, state: safeState }, null, 2));
      return;
    }
    if (!status.running) {
      console.log(status.stale ? "Oracle Runtime is stopped (stale state detected)." : "Oracle Runtime is stopped.");
      return;
    }
    console.log(`Oracle Runtime ${status.health?.version} is running.`);
    console.log(`  pid:       ${status.state?.pid}`);
    console.log(`  API:       http://${status.state?.host}:${status.state?.port}`);
    console.log(`  scheduler: ${status.health?.schedulerRunning ? "running" : "stopped"}`);
    console.log(`  storage:   ${status.health?.storage} (${status.state?.databasePath})`);
    console.log(`  workspace: ${status.state?.workspaceRoot ?? "(not recorded)"}`);
  });

daemonCmd
  .command("stop")
  .description("Gracefully stop Oracle Runtime")
  .action(async () => {
    const stopped = await stopDaemon(homeDir());
    console.log(stopped ? "Oracle Runtime stopped." : "Oracle Runtime is not running.");
  });

daemonCmd
  .command("events")
  .description("Stream daemon and scheduler events over WebSocket")
  .option("--after <id>", "Replay events after this event id", "0")
  .action(async (options) => {
    const client = await RuntimeClient.connect(homeDir());
    if (!client) throw new Error("Oracle Runtime is not running.");
    const { WebSocket } = await import("ws");
    const socket = new WebSocket(client.webSocketUrl(Number(options.after)));
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => console.error("Connected to Oracle Runtime events. Press Ctrl+C to stop."));
      socket.on("message", (data) => console.log(data.toString()));
      socket.on("error", reject);
      socket.on("close", () => resolve());
      process.once("SIGINT", () => socket.close(1000, "client stopped"));
    });
  });

// ── Remote Swarm ───────────────────────────────────────────────
program
  .command("connect")
  .description("Connect this machine to a Remote Swarm")
  .argument("<url>", "Oracle Runtime URL, for example https://oracle.example.com")
  .requiredOption("--project <id>", "Project room id")
  .requiredOption("--agent <name>", "Agent identity")
  .option("--token <token>", "Agent token (or set ORACLE_SWARM_TOKEN)")
  .action(async (url, options) => {
    const token = options.token ?? process.env.ORACLE_SWARM_TOKEN;
    if (!token) throw new Error("Provide --token or set ORACLE_SWARM_TOKEN.");
    const profile: SwarmConnectionProfile = {
      url,
      projectId: options.project,
      agentName: options.agent,
      token,
      connectedAt: new Date().toISOString()
    };
    const client = new SwarmClient(profile);
    const connected = await client.connect();
    if (
      connected.projectId !== profile.projectId
      || connected.agent.name !== profile.agentName
    ) {
      throw new Error(
        `Token belongs to ${connected.projectId}/${connected.agent.name}, `
        + `not ${profile.projectId}/${profile.agentName}.`
      );
    }
    await saveSwarmProfile(homeDir(), profile);
    console.log(`Connected ${profile.agentName} to Remote Swarm "${profile.projectId}".`);
    console.log(`  server: ${client.baseUrl.toString()}`);
    console.log(`  role:   ${connected.agent.role}`);
  });

async function requireSwarmClient(): Promise<SwarmClient> {
  const client = await SwarmClient.fromHome(homeDir());
  if (!client) {
    throw new Error("No Remote Swarm connection. Run `oracle connect <url> ...` first.");
  }
  return client;
}

function printSwarmMessage(
  message: import("./runtime/swarmService.js").SwarmMessage
): void {
  console.log(
    `${message.id} | ${message.ts} | from ${message.from} to ${message.to}`
    + (message.subject ? ` | ${message.subject}` : "")
  );
  console.log(`  ${message.body.split("\n").join("\n  ")}`);
}

function printSwarmTask(task: import("./runtime/swarmService.js").SwarmTask): void {
  console.log(
    `${task.id} | ${task.status} | ${task.title} | `
    + `${task.createdBy} -> ${task.assignee}`
  );
  if (task.description) console.log(`  ${task.description}`);
  for (const [index, item] of task.checklist.entries()) {
    console.log(`  ${index}: [${item.done ? "x" : " "}] ${item.text}`);
  }
  for (const note of task.notes) {
    console.log(`  [${note.ts}] ${note.agent}: ${note.text}`);
  }
}

const teamCmd = program
  .command("team")
  .description("Coordinate agents across machines through Remote Swarm");

teamCmd
  .command("token")
  .description("Issue a project-scoped agent token from the local Runtime")
  .requiredOption("--project <id>", "Project room id")
  .requiredOption("--agent <name>", "Agent identity")
  .option("--role <role>", "Agent role", "worker")
  .option("--project-name <name>", "Human-readable project name")
  .action(async (options) => {
    const runtime = await requireRuntimeClient();
    const issued = await runtime.issueSwarmToken({
      projectId: options.project,
      projectName: options.projectName,
      agentName: options.agent,
      role: options.role
    });
    console.log(
      `Token ${issued.id} issued for ${issued.projectId}/${issued.agentName} (${issued.role})`
    );
    console.log(issued.token);
    console.error("Save this token now. Oracle stores only its SHA-256 hash.");
  });

teamCmd
  .command("token-revoke")
  .description("Revoke an issued Remote Swarm token")
  .argument("<token-id>", "Token id returned during issuance")
  .action(async (tokenId) => {
    const revoked = await (await requireRuntimeClient()).revokeSwarmToken(tokenId);
    console.log(revoked ? `Revoked ${tokenId}.` : `Token not found: ${tokenId}`);
    if (!revoked) process.exitCode = 1;
  });

teamCmd
  .command("disconnect")
  .description("Remove the saved Remote Swarm connection from this machine")
  .action(async () => {
    const removed = await removeSwarmProfile(homeDir());
    console.log(removed ? "Remote Swarm connection removed." : "No saved connection.");
  });

teamCmd
  .command("status")
  .description("Show the connected project, agents, tasks, and unread work")
  .option("--json", "Print machine-readable output", false)
  .action(async (options) => {
    const status = await (await requireSwarmClient()).status();
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`Remote Swarm "${status.projectId}" — Oracle ${status.version}`);
    console.log(`  you:      ${status.agent.name} (${status.agent.role})`);
    console.log(`  agents:   ${status.agents.length}`);
    console.log(`  tasks:    ${status.activeTasks} active`);
    console.log(`  messages: ${status.unreadMessages} unread`);
  });

teamCmd
  .command("agents")
  .description("List agents and presence in the connected project")
  .action(async () => {
    const agents = await (await requireSwarmClient()).listAgents();
    if (!agents.length) {
      console.log("No agents connected.");
      return;
    }
    for (const agent of agents) {
      console.log(
        `${agent.name.padEnd(24)} ${agent.status.padEnd(7)} `
        + `${agent.role}  last seen ${agent.lastSeenAt}`
      );
    }
  });

teamCmd
  .command("send")
  .description("Send a message to a remote agent or broadcast with '*'")
  .requiredOption("-t, --to <agent>", "Recipient agent name, or '*'")
  .requiredOption("-b, --body <text>", "Message body")
  .option("-s, --subject <text>", "Subject line")
  .option("--reply-to <id>", "Message id this replies to")
  .action(async (options) => {
    const message = await (await requireSwarmClient()).send({
      to: options.to,
      body: options.body,
      subject: options.subject,
      replyTo: options.replyTo
    });
    console.log(`Sent ${message.id} to ${message.to}.`);
  });

teamCmd
  .command("inbox")
  .description("Show Remote Swarm messages (unread by default)")
  .option("--all", "Include acknowledged messages", false)
  .option("--limit <n>", "Maximum messages", "50")
  .option("--json", "Print machine-readable output", false)
  .action(async (options) => {
    const messages = await (await requireSwarmClient()).inbox({
      all: Boolean(options.all),
      limit: Number(options.limit)
    });
    if (options.json) {
      console.log(JSON.stringify(messages, null, 2));
      return;
    }
    if (!messages.length) {
      console.log("Remote inbox empty.");
      return;
    }
    for (const message of messages) printSwarmMessage(message);
  });

teamCmd
  .command("ack")
  .description("Acknowledge Remote Swarm messages")
  .argument("<ids...>", "Message ids")
  .action(async (ids) => {
    if (!ids.length) throw new Error("Provide at least one message id.");
    const acked = await (await requireSwarmClient()).acknowledge(ids);
    console.log(`Acked ${acked.length}/${ids.length}.`);
  });

teamCmd
  .command("watch")
  .description("Watch project events with replay after reconnect")
  .option("--after <id>", "Replay after this event id", "0")
  .action(async (options) => {
    const client = await requireSwarmClient();
    const { WebSocket } = await import("ws");
    let after = Number(options.after);
    let stopped = false;
    let activeSocket: InstanceType<typeof WebSocket> | undefined;
    const stop = () => {
      stopped = true;
      activeSocket?.close(1000, "client stopped");
    };
    process.once("SIGINT", stop);
    console.error(`Watching Remote Swarm "${client.profile.projectId}". Press Ctrl+C to stop.`);
    while (!stopped) {
      const socket = new WebSocket(client.webSocketUrl(after), {
        headers: client.webSocketHeaders()
      });
      activeSocket = socket;
      await new Promise<void>((resolve) => {
        socket.on("message", (data) => {
          const raw = data.toString();
          const event = JSON.parse(raw) as { id?: number };
          if (typeof event.id === "number") after = Math.max(after, event.id);
          console.log(raw);
        });
        socket.on("error", (error) => {
          console.error(`Remote Swarm event stream: ${error.message}`);
        });
        socket.on("close", () => resolve());
        if (stopped) socket.close(1000, "client stopped");
      });
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.off("SIGINT", stop);
  });

const teamTaskCmd = teamCmd
  .command("task")
  .description("Manage verified tasks in the connected Remote Swarm");

teamTaskCmd
  .command("create")
  .requiredOption("--title <text>", "Task title")
  .requiredOption("--assignee <agent>", "Agent responsible for the work")
  .option("--description <text>", "Task description")
  .option("--checklist <items...>", "Verification steps")
  .action(async (options) => {
    const task = await (await requireSwarmClient()).createTask({
      title: options.title,
      description: options.description,
      assignee: options.assignee,
      checklist: options.checklist
    });
    console.log(`Created ${task.id}, assigned to ${task.assignee}.`);
  });

teamTaskCmd
  .command("list")
  .option("--assignee <agent>")
  .option("--created-by <agent>")
  .option("--status <status>")
  .option("--active", "Only active tasks", false)
  .option("--json", "Print machine-readable output", false)
  .action(async (options) => {
    const tasks = await (await requireSwarmClient()).listTasks({
      assignee: options.assignee,
      createdBy: options.createdBy,
      status: options.status,
      activeOnly: Boolean(options.active)
    });
    if (options.json) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    if (!tasks.length) {
      console.log("No remote tasks found.");
      return;
    }
    for (const task of tasks) printSwarmTask(task);
  });

teamTaskCmd
  .command("get")
  .argument("<id>", "Task id")
  .action(async (id) => {
    printSwarmTask(await (await requireSwarmClient()).getTask(id));
  });

teamTaskCmd
  .command("update")
  .argument("<id>", "Task id")
  .option("--status <status>")
  .option("--note <text>")
  .action(async (id, options) => {
    const task = await (await requireSwarmClient()).updateTask(id, {
      status: options.status,
      note: options.note
    });
    printSwarmTask(task);
  });

teamTaskCmd
  .command("check")
  .argument("<id>", "Task id")
  .argument("<index>", "Checklist index")
  .option("--undo", "Uncheck the item", false)
  .action(async (id, index, options) => {
    const task = await (await requireSwarmClient()).checkTask(
      id,
      Number(index),
      !options.undo
    );
    printSwarmTask(task);
  });

teamTaskCmd
  .command("submit")
  .argument("<id>", "Task id")
  .requiredOption("--summary <text>", "Work summary")
  .action(async (id, options) => {
    const task = await (await requireSwarmClient()).submitTask(id, options.summary);
    console.log(`Submitted ${task.id} for review.`);
  });

teamTaskCmd
  .command("close")
  .argument("<id>", "Task id")
  .option("--reject", "Return the task to the assignee", false)
  .option("--note <text>", "Decision note")
  .action(async (id, options) => {
    const task = await (await requireSwarmClient()).closeTask(
      id,
      !options.reject,
      options.note
    );
    console.log(
      task.status === "done"
        ? `Closed ${task.id} as done.`
        : `Returned ${task.id} to ${task.assignee}.`
    );
  });

// ── Control Center & approval inbox ─────────────────────────────
async function requireRuntimeClient(): Promise<RuntimeClient> {
  const client = await RuntimeClient.connect(homeDir());
  if (!client) {
    throw new Error("Oracle Runtime is not running. Start it with `oracle daemon start`.");
  }
  return client;
}

function defaultActor(): string {
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  try {
    return os.userInfo().username || "operator";
  } catch {
    return "operator";
  }
}

const controlCmd = program
  .command("control")
  .description("Inspect agent-governed approvals, tasks, memory, and audit state");
/*
  .option("--once", "Render one snapshot and exit", false)
  .option("--plain", "Use the dependency-free ANSI TUI", false)
  .option("--interval <ms>", "Refresh interval in milliseconds", "2000")
  .option("--actor <name>", "Approval actor recorded by the TUI", defaultActor())
  .action(async (options) => {
    const client = await requireRuntimeClient();
    const { renderControlTui } = await import("./control/tui.js");
    let snapshot = await client.getControlSnapshot();
    let selected = 0;
    const intervalMs = Number(options.interval);
    if (!Number.isFinite(intervalMs) || intervalMs < 500) {
      throw new Error("--interval must be at least 500 milliseconds.");
    }
    if (!options.once && !options.plain && process.stdin.isTTY && process.stdout.isTTY) {
      const { renderControlInk } = await import("./control/ink-app.js");
      await renderControlInk({
        client,
        initial: snapshot,
        actor: options.actor,
        intervalMs
      });
      return;
    }
    let statusMessage = "";
    const render = () => {
      const screen = renderControlTui(snapshot, selected);
      if (process.stdout.isTTY && !options.once) process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(`${screen}\n`);
      if (statusMessage) process.stdout.write(`\x1b[33m${statusMessage}\x1b[0m\n`);
    };
    render();
    if (options.once || !process.stdin.isTTY || !process.stdout.isTTY) return;

    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        snapshot = await client.getControlSnapshot();
        selected = Math.min(selected, Math.max(0, snapshot.approvals.items.length - 1));
        statusMessage = "";
        render();
      } catch (error) {
        statusMessage = error instanceof Error ? error.message : String(error);
        render();
      } finally {
        refreshing = false;
      }
    };
    const timer = setInterval(() => void refresh(), intervalMs);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let onKey: ((key: string) => void) | undefined;
    await new Promise<void>((resolve) => {
      onKey = (key: string) => {
        if (key === "q" || key === "") {
          resolve();
          return;
        }
        if (key === "j" || key === "[B") {
          selected = Math.min(selected + 1, Math.max(0, snapshot.approvals.items.length - 1));
          render();
          return;
        }
        if (key === "k" || key === "[A") {
          selected = Math.max(0, selected - 1);
          render();
          return;
        }
        if (key === "r") {
          void refresh();
          return;
        }
        if ((key === "a" || key === "x") && snapshot.approvals.items[selected]) {
          const approval = snapshot.approvals.items[selected];
          void client.decideApproval(approval.id, {
            decision: key === "a" ? "approve" : "reject",
            decidedBy: options.actor,
            expectedVersion: approval.version,
            channel: "tui",
            note: key === "x" ? "Rejected from Oracle Control." : undefined
          }).then(
            () => refresh(),
            (error: unknown) => {
              statusMessage = error instanceof Error ? error.message : String(error);
              render();
            }
          );
        }
      };
      process.stdin.on("data", onKey);
    }).finally(() => {
      clearInterval(timer);
      if (onKey) process.stdin.off("data", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    });
  });
*/

/* Dashboard removed; approvals are handled by authorized agents.
controlCmd
  .command("url")
  .description("Print the authenticated loopback Dashboard URL")
  .action(async () => {
    const client = await requireRuntimeClient();
    console.log(client.controlCenterUrl());
  });
*/

controlCmd
  .command("snapshot")
  .description("Print Control Center data as JSON")
  .action(async () => {
    const client = await requireRuntimeClient();
    console.log(JSON.stringify(await client.getControlSnapshot(), null, 2));
  });

const approvalCmd = program
  .command("approval")
  .description("Manage the persistent Control Center approval inbox");

function printApproval(approval: import("./control/types.js").ApprovalRequest): void {
  const tone = riskTone(approval.risk);
  const riskColor = tone === "danger" ? "\x1b[31m" : tone === "warn" ? "\x1b[33m" : "\x1b[32m";
  console.log(
    `${riskColor}${approval.risk.toUpperCase()}\x1b[0m ${approval.id} | ${approval.status} | ${approval.title}`
  );
  console.log(`  ${approval.requestedBy} -> ${approval.assignedTo} | ${approval.kind}`);
  console.log(
    `  quorum: ${approval.approvalCount}/${approval.requiredApprovals} | version: ${approval.version}`
  );
  console.log(`  reviewers: ${approval.authorizedReviewers.join(", ")}`);
  if (approval.taskId) console.log(`  task: ${approval.taskId}`);
  if (approval.description) console.log(`  ${approval.description}`);
  if (approval.expiresAt) console.log(`  expires: ${approval.expiresAt}`);
  if (approval.payloadHash) console.log(`  payload: ${approval.payloadHash}`);
  for (const vote of approval.votes) {
    console.log(`  vote: ${vote.actor} ${vote.decision} via ${vote.channel}`);
  }
  if (approval.decidedBy) {
    console.log(`  decision: ${approval.decidedBy}${approval.decisionNote ? ` — ${approval.decisionNote}` : ""}`);
  }
}

approvalCmd
  .command("list")
  .description("List approval requests")
  .option("--status <status>", "pending | approved | rejected | cancelled | expired", "pending")
  .action(async (options) => {
    if (!["pending", "approved", "rejected", "cancelled", "expired"].includes(options.status)) {
      throw new Error("status must be pending, approved, rejected, cancelled, or expired.");
    }
    const approvals = await (await requireRuntimeClient()).listApprovals(options.status);
    if (!approvals.length) {
      console.log(`No ${options.status} approvals.`);
      return;
    }
    for (const approval of approvals) printApproval(approval);
  });

approvalCmd
  .command("show")
  .description("Show one approval request")
  .argument("<id>", "Approval id")
  .action(async (id) => {
    const approval = await (await requireRuntimeClient()).getApproval(id);
    if (!approval) {
      console.error(`Approval not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    printApproval(approval);
    console.log(`  metadata: ${JSON.stringify(approval.metadata)}`);
  });

approvalCmd
  .command("request")
  .description("Create a local approval request")
  .requiredOption("--title <text>", "Approval title")
  .option("--description <text>", "Decision context")
  .requiredOption("--requested-by <agent>", "Requesting agent")
  .requiredOption("--assigned-to <agent>", "Authorized agent responsible for the decision")
  .option("--reviewers <actors>", "Comma-separated authorized reviewer identities")
  .option("--quorum <n>", "Required approval votes")
  .option("--expires-in <minutes>", "Minutes before the request expires")
  .option("--local-only", "Do not allow Telegram callback decisions", false)
  .option("--kind <kind>", "custom | command | policy", "custom")
  .option("--risk <risk>", "low | medium | high", "medium")
  .option("--task <id>", "Linked task id")
  .action(async (options) => {
    if (!["custom", "command", "policy"].includes(options.kind)) {
      throw new Error("kind must be custom, command, or policy.");
    }
    if (!["low", "medium", "high"].includes(options.risk)) {
      throw new Error("risk must be low, medium, or high.");
    }
    const reviewers = options.reviewers
      ? String(options.reviewers).split(",").map((value) => value.trim()).filter(Boolean)
      : undefined;
    const requiredApprovals = options.quorum === undefined
      ? undefined
      : Number(options.quorum);
    if (
      requiredApprovals !== undefined
      && (!Number.isInteger(requiredApprovals) || requiredApprovals < 1)
    ) throw new Error("--quorum must be a positive integer.");
    const expiresInMinutes = options.expiresIn === undefined
      ? undefined
      : Number(options.expiresIn);
    if (
      expiresInMinutes !== undefined
      && (!Number.isFinite(expiresInMinutes) || expiresInMinutes <= 0)
    ) throw new Error("--expires-in must be greater than zero.");
    const approval = await (await requireRuntimeClient()).createApproval({
      kind: options.kind,
      title: options.title,
      description: options.description,
      requestedBy: options.requestedBy,
      assignedTo: options.assignedTo,
      authorizedReviewers: reviewers,
      requiredApprovals,
      risk: options.risk,
      taskId: options.task,
      expiresInMinutes,
      localOnly: Boolean(options.localOnly)
    });
    printApproval(approval);
  });

for (const decision of ["approve", "reject"] as const) {
  approvalCmd
    .command(decision)
    .description(`${decision === "approve" ? "Approve" : "Reject"} a pending request`)
    .argument("<id>", "Approval id")
    .requiredOption("--by <actor>", "Decision maker")
    .option("--note <text>", "Decision note")
    .action(async (id, options) => {
      const client = await requireRuntimeClient();
      const current = await client.getApproval(id);
      if (!current) throw new Error(`Approval not found: ${id}`);
      const approval = await client.decideApproval(id, {
        decision,
        decidedBy: options.by,
        expectedVersion: current.version,
        channel: "agent",
        note: options.note
      });
      printApproval(approval);
    });
}

// ── schedule ────────────────────────────────────────────
// ── situated companion ──────────────────────────────────────────────────────
const companionCmd = program
  .command("companion")
  .description("Manage local-first presence and self-initiated conversation");

function printCompanionIntent(intent: CompanionIntent): void {
  const color = intent.action === "speak" ? "\x1b[32m" : "\x1b[2m";
  console.log(`${color}${intent.action.toUpperCase()}\x1b[0m ${intent.candidate}`);
  if (intent.message) console.log(`  ${intent.message}`);
  console.log(`  reason: ${intent.reason}`);
  console.log(
    `  score: ${intent.score.total.toFixed(2)} / ${intent.score.threshold.toFixed(2)}`
  );
  console.log(`  intent: ${intent.id}`);
}

companionCmd
  .command("status")
  .description("Show current semantic presence, controls, and recent intents")
  .option("--json", "Print machine-readable status", false)
  .option("--limit <n>", "Number of recent intents", "5")
  .action(async (options) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("--limit must be an integer between 1 and 100.");
    }
    const state = await (await requireRuntimeClient()).getCompanionState(limit);
    if (options.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    console.log("Oracle Companion");
    if (state.presence) {
      console.log(
        `  presence: ${state.presence.state} via ${state.presence.source}`
        + ` (${Math.round(state.presence.confidence * 100)}% confidence)`
      );
      console.log(
        `  freshness: ${state.presenceActive ? "active" : "expired"}`
        + ` until ${state.presence.expiresAt}`
      );
    } else {
      console.log("  presence: unknown (no semantic context stored)");
    }
    const pause = state.settings.pause;
    console.log(
      `  companion: ${pause.paused ? "paused" : "active"}`
      + (pause.pausedUntil ? ` until ${pause.pausedUntil}` : "")
    );
    console.log(
      `  quiet hours: ${state.settings.quietHours.startHour}:00-`
      + `${state.settings.quietHours.endHour}:00 local`
    );
    if (state.recentIntents[0]) {
      console.log("Latest decision:");
      printCompanionIntent(state.recentIntents[0]);
    }
  });

companionCmd
  .command("presence")
  .description("Submit semantic presence; raw coordinates are never accepted")
  .argument("<state>", PRESENCE_STATES.join(" | "))
  .option("--source <source>", PRESENCE_SOURCES.join(" | "), "manual")
  .option("--confidence <0..1>", "Context confidence", "1")
  .option("--ttl <minutes>", "Freshness lifetime in minutes", "120")
  .option("--observed-at <iso>", "ISO-8601 observation time")
  .option("--json", "Print machine-readable result", false)
  .action(async (stateValue, options) => {
    if (!PRESENCE_STATES.includes(stateValue as PresenceState)) {
      throw new Error(`state must be one of: ${PRESENCE_STATES.join(", ")}.`);
    }
    if (!PRESENCE_SOURCES.includes(options.source as PresenceSource)) {
      throw new Error(`source must be one of: ${PRESENCE_SOURCES.join(", ")}.`);
    }
    const confidence = Number(options.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("--confidence must be a number between 0 and 1.");
    }
    const ttlMinutes = Number(options.ttl);
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
      throw new Error("--ttl must be an integer between 1 and 1440.");
    }
    const result = await (await requireRuntimeClient()).updateCompanionPresence({
      state: stateValue as PresenceState,
      source: options.source as PresenceSource,
      confidence,
      ttlMinutes,
      observedAt: options.observedAt
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `Presence updated: ${result.presence.state} via ${result.presence.source}`
      + ` until ${result.presence.expiresAt}`
    );
    printCompanionIntent(result.intent);
  });

companionCmd
  .command("evaluate")
  .description("Run the companion decision loop against current context")
  .option("--json", "Print machine-readable intent", false)
  .action(async (options) => {
    const intent = await (await requireRuntimeClient()).evaluateCompanion();
    if (options.json) {
      console.log(JSON.stringify(intent, null, 2));
      return;
    }
    printCompanionIntent(intent);
  });

companionCmd
  .command("pause")
  .description("Suppress companion speech until resumed or a timer elapses")
  .option("--minutes <n>", "Automatically resume after this many minutes")
  .action(async (options) => {
    const minutes = options.minutes === undefined ? undefined : Number(options.minutes);
    if (
      minutes !== undefined
      && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080)
    ) {
      throw new Error("--minutes must be an integer between 1 and 10080.");
    }
    const pause = await (await requireRuntimeClient()).pauseCompanion(minutes);
    console.log(
      pause.pausedUntil
        ? `Oracle Companion paused until ${pause.pausedUntil}.`
        : "Oracle Companion paused until explicitly resumed."
    );
  });

companionCmd
  .command("resume")
  .description("Allow the companion to consider speaking again")
  .action(async () => {
    await (await requireRuntimeClient()).resumeCompanion();
    console.log("Oracle Companion resumed.");
  });

function printCompanionDelivery(delivery: CompanionDelivery): void {
  const color = delivery.status === "delivered"
    ? "\x1b[32m"
    : delivery.status === "failed"
      ? "\x1b[31m"
      : "\x1b[2m";
  console.log(
    `${color}${delivery.status.toUpperCase()}\x1b[0m ${delivery.channel}`
    + `  intent ${delivery.intentId}`
  );
  if (delivery.detail) console.log(`  detail: ${delivery.detail}`);
}

companionCmd
  .command("channels")
  .description("Show local notification channels and whether they can deliver")
  .option("--json", "Print machine-readable channel status", false)
  .action(async (options) => {
    const channels = await (await requireRuntimeClient()).getCompanionChannels();
    if (options.json) {
      console.log(JSON.stringify(channels, null, 2));
      return;
    }
    if (channels.length === 0) {
      console.log("No notification channels are configured.");
      return;
    }
    for (const channel of channels) {
      const state = !channel.enabled
        ? "disabled"
        : channel.available ? "ready" : "unavailable";
      console.log(`  ${channel.channel}: ${state}`);
      if (channel.reason) console.log(`    ${channel.reason}`);
    }
  });

companionCmd
  .command("channel")
  .description("Enable or disable a local notification channel (off by default)")
  .argument("<action>", "enable | disable")
  .argument("<channel>", "Channel name, e.g. windows-toast")
  .action(async (action: string, channel: string) => {
    if (action !== "enable" && action !== "disable") {
      throw new Error("action must be enable or disable.");
    }
    const channels = await (await requireRuntimeClient())
      .setCompanionChannelEnabled(channel, action === "enable");
    const updated = channels.find((item) => item.channel === channel);
    console.log(
      `Channel ${channel} is now ${updated?.enabled ? "enabled" : "disabled"}.`
    );
    if (updated && !updated.available && updated.reason) {
      console.log(`  note: ${updated.reason}`);
    }
  });

companionCmd
  .command("deliveries")
  .description("Show recent notification delivery attempts and suppressions")
  .option("--json", "Print machine-readable delivery history", false)
  .option("--limit <n>", "Number of deliveries", "10")
  .action(async (options) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("--limit must be an integer between 1 and 100.");
    }
    const deliveries = await (await requireRuntimeClient()).getCompanionDeliveries(limit);
    if (options.json) {
      console.log(JSON.stringify(deliveries, null, 2));
      return;
    }
    if (deliveries.length === 0) {
      console.log("No delivery attempts recorded.");
      return;
    }
    for (const delivery of deliveries) printCompanionDelivery(delivery);
  });

companionCmd
  .command("notify-test")
  .description("Evaluate now and dispatch the result to local channels")
  .option("--json", "Print machine-readable result", false)
  .action(async (options) => {
    const result = await (await requireRuntimeClient()).notifyTestCompanion();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printCompanionIntent(result.intent);
    if (result.deliveries.length === 0) {
      console.log("  no delivery attempted (silence is a valid outcome)");
      return;
    }
    for (const delivery of result.deliveries) printCompanionDelivery(delivery);
  });

companionCmd
  .command("forget")
  .description("Delete all stored semantic presence")
  .action(async () => {
    const result = await (await requireRuntimeClient()).forgetCompanionPresence();
    console.log(`Forgot ${result.forgotten} semantic presence record(s).`);
  });

const schedCmd = program.command("schedule").description("Manage scheduled cron tasks");

interface SchedulerAccess {
  listTasks(): Promise<CronTask[]>;
  getTask(id: string): Promise<CronTask | null>;
  addTask(input: CreateCronTaskInput): Promise<CronTask>;
  updateTask(id: string, input: UpdateCronTaskInput): Promise<CronTask | null>;
  removeTask(id: string): Promise<boolean>;
  runOnce(id: string): Promise<{ result: "success" | "error"; output: string }>;
}

async function makeScheduler(): Promise<SchedulerAccess> {
  const root = homeDir();
  const client = await RuntimeClient.connect(root);
  if (client) {
    return {
      listTasks: () => client.listSchedules(),
      getTask: (id) => client.getSchedule(id),
      addTask: (input) => client.createSchedule(input),
      updateTask: (id, input) => client.updateSchedule(id, input),
      removeTask: (id) => client.removeSchedule(id),
      runOnce: (id) => client.runSchedule(id)
    };
  }

  // Daemon not running: keep CLI useful while writing to the same SQLite
  // backend. The next daemon start will load these tasks.
  const [
    { RuntimeDatabase },
    { RuntimeEventBus },
    { SchedulerService }
  ] = await Promise.all([
    import("./runtime/database.js"),
    import("./runtime/events.js"),
    import("./runtime/schedulerService.js")
  ]);
  const database = new RuntimeDatabase(root);
  const service = new SchedulerService(database, new RuntimeEventBus(database));
  await service.store.importLegacyDirectory(root);
  return {
    listTasks: () => service.list(),
    getTask: (id) => service.get(id),
    addTask: (input) => service.create(input),
    updateTask: (id, input) => service.update(id, input),
    removeTask: (id) => service.remove(id),
    runOnce: (id) => service.run(id)
  };
}

function printCronTask(t: CronTask): void {
  const statusIcon = t.status === "active" ? "\x1b[32m●\x1b[0m" : t.status === "paused" ? "\x1b[33m○\x1b[0m" : "\x1b[31m●\x1b[0m";
  console.log(`${statusIcon} ${t.id}  ${t.name.padEnd(24)} ${t.cron.padEnd(20)} ${t.command}`);
  if (t.description) console.log(`       ${t.description}`);
  if (t.lastRunAt) {
    const icon = t.lastResult === "success" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`       last: ${icon} ${t.lastRunAt.slice(0, 19)}  ${(t.lastOutput ?? "").slice(0, 80)}`);
  }
}

schedCmd
  .command("list")
  .description("List all scheduled tasks")
  .action(async () => {
    const engine = await makeScheduler();
    const tasks = await engine.listTasks();
    if (!tasks.length) { console.log("No scheduled tasks. Use `oracle schedule add` to create one."); return; }
    for (const t of tasks) printCronTask(t);
  });

schedCmd
  .command("add")
  .description("Add a scheduled cron task")
  .argument("<name>", "Task name")
  .argument("<cron>", "Cron expression (e.g. '*/5 * * * *' for every 5 minutes)")
  .argument("<command>", "Shell command to run")
  .option("-d, --description <text>", "Task description")
  .action(async (name: string, cronExpr: string, command: string, options: { description?: string }) => {
    const engine = await makeScheduler();
    const task = await engine.addTask({ name, cron: cronExpr, command, description: options.description });
    console.log(`Scheduled task created: ${task.id}  (${task.cron})`);
  });

schedCmd
  .command("update")
  .description("Update a scheduled task")
  .argument("<id>", "Task id")
  .option("--name <name>", "New task name")
  .option("--cron <expression>", "New cron expression")
  .option("--command <command>", "New shell command")
  .option("-d, --description <text>", "New description")
  .option("--status <status>", "active | paused | deleted")
  .action(async (id: string, options) => {
    if (options.status && !["active", "paused", "deleted"].includes(options.status)) {
      throw new Error("status must be active, paused, or deleted.");
    }
    const engine = await makeScheduler();
    const task = await engine.updateTask(id, {
      name: options.name,
      cron: options.cron,
      command: options.command,
      description: options.description,
      status: options.status
    });
    if (!task) { console.error(`Task not found: ${id}`); process.exitCode = 1; return; }
    printCronTask(task);
  });

schedCmd
  .command("remove")
  .description("Remove a scheduled task")
  .argument("<id>", "Task id")
  .action(async (id) => {
    const engine = await makeScheduler();
    const removed = await engine.removeTask(id);
    if (!removed) { console.error(`Task not found: ${id}`); process.exitCode = 1; return; }
    console.log(`Removed task ${id}.`);
  });

schedCmd
  .command("run")
  .description("Run a scheduled task immediately")
  .argument("<id>", "Task id")
  .action(async (id) => {
    const engine = await makeScheduler();
    const result = await engine.runOnce(id);
    if (result.output) console.log(result.output);
    process.exitCode = result.result === "success" ? 0 : 1;
  });

schedCmd
  .command("watch")
  .description("Run the Runtime daemon in the foreground (legacy scheduler alias)")
  .option("--once", "Run active tasks once then exit", false)
  .action(async (options) => {
    if (options.once) {
      const engine = await makeScheduler();
      const active = (await engine.listTasks()).filter((task) => task.status === "active");
      console.error("Running once and exiting...");
      for (const t of active) {
        const { result, output } = await engine.runOnce(t.id);
        if (output) console.log(output);
        console.error(`[${result}] ${t.name}`);
      }
      return;
    }
    console.error("`oracle schedule watch` now runs the full Runtime daemon. Prefer `oracle daemon run`.");
    await runDaemonForeground("127.0.0.1", 4777);
  });

// ── swarm ───────────────────────────────────────────────────────
const swarmCmd = program.command("swarm").description("Autonomous multi-agent swarm workflow");

async function makeSwarmStore(): Promise<import("./orchestrator/swarmStore.js").SwarmStore> {
  return new SwarmStore(homeDir());
}

swarmCmd
  .command("create")
  .description("Create a new swarm workflow with named agent roles")
  .argument("<title>", "Workflow title")
  .requiredOption("-a, --architect <id>", "Architect agent id")
  .requiredOption("-c, --coder <id>", "Coder agent id")
  .requiredOption("-r, --reviewer <id>", "Reviewer agent id")
  .requiredOption("-q, --qa <id>", "QA agent id")
  .action(async (title: string, options) => {
    const { workflow, task } = await makeCoordination(true).createSwarmWorkflow(title, [
      { id: options.architect, name: options.architect, role: "architect", capabilities: [] },
      { id: options.coder, name: options.coder, role: "coder", capabilities: [] },
      { id: options.reviewer, name: options.reviewer, role: "reviewer", capabilities: [] },
      { id: options.qa, name: options.qa, role: "qa", capabilities: [] },
    ]);
    console.log(`Swarm workflow created: ${workflow.id}`);
    console.log(`  task:     ${task.id}`);
    console.log(`  title:    ${title}`);
    console.log(`  architect: ${options.architect}`);
    console.log(`  coder:    ${options.coder}`);
    console.log(`  reviewer:  ${options.reviewer}`);
    console.log(`  qa:       ${options.qa}`);
  });

swarmCmd
  .command("propose")
  .description("Submit a proposal for swarm review")
  .argument("<workflow-id>", "Swarm workflow id")
  .argument("<agent-id>", "Proposing agent id")
  .argument("<action>", "Proposed action description")
  .action(async (workflowId: string, agentId: string, action: string) => {
    try {
      const { task, proposal } = await makeCoordination(true).proposeSwarmAction(workflowId, agentId, action);
      console.log(`Proposal submitted: ${proposal.id}`);
      console.log(`  task:      ${task.id}`);
      console.log(`  proposer:  ${agentId}`);
      console.log(`  action:    ${action}`);
      console.log(`  status:    ${proposal.status}`);
      console.log(`  quorum:    ${proposal.requiredQuorum}`);
      console.log(`  threshold: ${(proposal.approvalThresholdRatio * 100).toFixed(0)}%`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

swarmCmd
  .command("vote")
  .description("Vote on a swarm proposal")
  .argument("<proposal-id>", "Proposal id")
  .argument("<agent-id>", "Reviewer agent id")
  .argument("<decision>", "approve | reject | abstain")
  .argument("[justification]", "Optional vote justification")
  .action(async (proposalId: string, agentId: string, decision: string, justification?: string) => {
    if (!["approve", "reject", "abstain"].includes(decision)) {
      console.error(`Invalid decision: ${decision}. Expected approve, reject, or abstain.`);
      process.exitCode = 1;
      return;
    }
    const result = await makeCoordination(true).voteOnSwarmProposal(
      proposalId,
      agentId,
      decision as import("./tasks/consensus.js").VoteDecision,
      justification ?? ""
    );
    if (!result) { console.error(`Proposal not found: ${proposalId}`); process.exitCode = 1; return; }
    const updated = result.proposal;
    console.log(`Vote recorded: ${agentId} → ${decision}`);
    console.log(`  proposal:  ${proposalId}`);
    console.log(`  votes:     ${updated.votes.length}`);
    const summary = updated.votes.map((v) => `    ${v.agentId}: ${v.decision}`).join("\n");
    console.log(summary);
    if (updated.status !== "pending") {
      console.log(`  outcome:   ${updated.status.toUpperCase()}`);
    }
  });

swarmCmd
  .command("recover")
  .description("Recover interrupted workflows and replay pending linked messages without duplicates")
  .action(async () => {
    const report = await makeCoordination(true).recover();
    console.log(`Recovery complete.`);
    console.log(`  workflows: ${report.workflowsScanned} scanned, ${report.workflowsRepaired} repaired`);
    console.log(`  tasks:     ${report.tasksCreated} recreated`);
    console.log(`  proposals: ${report.proposalsReconciled} reconciled`);
    console.log(`  messages:  ${report.messagesDelivered} delivered`);
    if (report.errors.length) {
      for (const error of report.errors) console.log(`  error ${error.workflowId}: ${error.error}`);
      process.exitCode = 1;
    }
  });

swarmCmd
  .command("status")
  .description("Show active swarm workflows and their proposals")
  .action(async () => {
    const workflows = await (await makeSwarmStore()).list();
    if (!workflows.length) { console.log("No active swarm workflows."); return; }
    for (const wf of workflows) {
      console.log(`\nWorkflow: ${wf.id}  (${wf.title})`);
      console.log(`  status: ${wf.status}${wf.primaryTaskId ? `  task: ${wf.primaryTaskId}` : ""}`);
      console.log(`  roles: ${Object.entries(wf.assignedRoles).map(([r, a]) => `${r}=${a}`).join(", ")}`);
      if (!wf.proposals.length) { console.log("  proposals: (none)"); continue; }
      for (const p of wf.proposals) {
        const decided = p.votes.filter((v) => v.decision !== "abstain");
        const approved = decided.filter((v) => v.decision === "approve").length;
        console.log(`  proposal ${p.id}  [${p.status}]  proposer: ${p.proposerAgentId}`);
        console.log(`    action: ${p.proposedAction}`);
        console.log(`    votes: ${approved}/${decided.length} approve  quorum: ${p.requiredQuorum}  threshold: ${(p.approvalThresholdRatio * 100).toFixed(0)}%`);
      }
    }
  });

// ── audit ───────────────────────────────────────────────────────
const auditCmd = program.command("audit").description("View agent audit trail and policy violations");

const sandboxCmd = program.command("sandbox").description("Inspect Oracle command-execution boundaries");

sandboxCmd
  .command("doctor")
  .description("Show the active sandbox policy and whether Docker is available")
  .option("--cwd <path>", "Workspace root", process.cwd())
  .option("--json", "Print machine-readable output", false)
  .action(async (options: { cwd?: string; json?: boolean }) => {
    const workspaceRoot = path.resolve(options.cwd ?? process.cwd());
    const { loadPolicy } = await import("./agent/policy.js");
    const policy = await loadPolicy(workspaceRoot);
    const docker = await new Promise<{ available: boolean; detail: string }>((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile("docker", ["version", "--format", "{{.Server.Version}}"], { windowsHide: true }, (error, stdout, stderr) => {
          resolve(error
            ? { available: false, detail: (stderr || error.message).trim() }
            : { available: true, detail: stdout.trim() || "available" });
        });
      }).catch((error) => resolve({ available: false, detail: error instanceof Error ? error.message : String(error) }));
    });
    const isolated = policy.sandbox.mode === "docker" && docker.available;
    const report = {
      workspaceRoot,
      sandbox: policy.sandbox,
      docker,
      executionBoundary: isolated ? "sandbox-isolated" : "policy-constrained",
      failClosed: policy.sandbox.mode === "docker"
    };
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`Execution boundary: ${report.executionBoundary}`);
    console.log(`  mode:       ${policy.sandbox.mode}`);
    console.log(`  network:    ${policy.sandbox.network}`);
    console.log(`  workspace:  ${workspaceRoot}`);
    console.log(`  image:      ${policy.sandbox.image}`);
    console.log(`  Docker:     ${docker.available ? `available (${docker.detail})` : `unavailable (${docker.detail})`}`);
    console.log(`  fallback:   ${report.failClosed ? "disabled" : "not applicable (policy-only mode)"}`);
  });

auditCmd
  .command("verify")
  .description("Verify the tamper-evident audit hash chain")
  .option("--cwd <path>", "Workspace root", process.cwd())
  .option("--json", "Output verification as JSON")
  .action(async (options: { cwd?: string; json?: boolean }) => {
    const { AuditLogger } = await import("./observability/audit.js");
    const verification = await new AuditLogger().verify(options.cwd ?? process.cwd());
    if (options.json) {
      console.log(JSON.stringify(verification, null, 2));
    } else if (verification.valid) {
      console.log(
        `Audit chain valid: ${verification.verifiedEntries} verified`
        + (verification.legacyEntries ? `, ${verification.legacyEntries} legacy unsigned` : "")
        + (verification.headHash ? `\nHead: ${verification.headHash}` : "")
      );
    } else {
      console.error(
        `Audit chain invalid at entry ${verification.brokenAt}: ${verification.reason}`
      );
      process.exitCode = 1;
    }
  });

auditCmd
  .command("show")
  .description("Show audit log entries for a session")
  .option("-n, --limit <n>", "Max entries to show", "50")
  .option("--cwd <path>", "Workspace root", process.cwd())
  .action(async (options: { limit?: string; cwd?: string }) => {
    const { AuditLogger } = await import("./observability/audit.js");
    const workspaceRoot = options.cwd ?? process.cwd();
    const logger = new AuditLogger();
    const records = await logger.readRecords(workspaceRoot, Number(options.limit ?? 50));
    if (!records.length) { console.log("No audit records found."); return; }
    for (const r of records) {
      const icon = r.action === "policy_denied" ? "\x1b[31m✗\x1b[0m" : "\x1b[36m●\x1b[0m";
      console.log(`${icon} [${r.timestamp.slice(0, 19)}] ${r.agentId ?? "?"}  ${r.action}  ${r.target}`);
      if (r.details) console.log(`    ${JSON.stringify(r.details).slice(0, 120)}`);
    }
  });

auditCmd
  .command("violations")
  .description("Show only policy denial events")
  .option("-n, --limit <n>", "Max entries to show", "50")
  .option("--cwd <path>", "Workspace root", process.cwd())
  .action(async (options: { limit?: string; cwd?: string }) => {
    const { AuditLogger } = await import("./observability/audit.js");
    const workspaceRoot = options.cwd ?? process.cwd();
    const logger = new AuditLogger();
    const records = await logger.readRecords(workspaceRoot, Number(options.limit ?? 50));
    const denials = records.filter((r) => r.action === "policy_denied");
    if (!denials.length) { console.log("No policy violations recorded."); return; }
    for (const r of denials) {
      console.log(`\x1b[31m✗\x1b[0m [${r.timestamp.slice(0, 19)}] ${r.agentId ?? "?"}  ${r.target}`);
      if (r.details) console.log(`    ${JSON.stringify(r.details).slice(0, 120)}`);
    }
  });

// ── init ────────────────────────────────────────────────────────
const initCmd = program.command("init").description("Initialize .oracle/ in the current workspace");

initCmd
  .command("workspace")
  .description("Create .oracle/ with policy.json, config.json, and docs/ directory")
  .option("--force", "Overwrite existing files", false)
  .action(async (options: { force?: boolean }) => {
    const root = process.cwd();
    const oracleDir = path.join(root, ".oracle");
    await fs.mkdir(oracleDir, { recursive: true });
    await fs.mkdir(path.join(oracleDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(oracleDir, "skills"), { recursive: true });

    const policyPath = path.join(oracleDir, "policy.json");
    const configPath = path.join(oracleDir, "config.json");

    const defaultPolicy = {
      forbiddenGlobs: [".env", ".env.", "id_rsa", "id_ed25519", ".pem", "credentials.json", ".oracle/policy.json"],
      forbiddenCommands: ["rm -rf /", "rm -rf c:", "rm -rf c:\\", "mkfs", "dd if=", ":(){ :|:& };:"],
      maxMutationsPerSession: 50,
      approval: {
        mode: "risky",
        expiryMinutes: 30,
        allowTelegramHighRisk: false
      },
      sandbox: {
        mode: "none",
        image: "node:24-bookworm-slim",
        network: "none",
        memoryMb: 2048,
        cpuCount: 2,
        pidsLimit: 256,
        environment: []
      }
    };
    const defaultConfig = {
      provider: "codex",
      model: "gpt-5.4",
      include: ["src/**/*", "README.md", "package.json"],
      exclude: ["**/*.test.ts", "**/node_modules/**", "**/dist/**", "**/build/**"],
      maxFileSizeBytes: 1000000,
      maxInputBytes: 5000000,
    };

    const writeIf = async (p: string, data: Record<string, unknown>) => {
      try {
        await fs.readFile(p, "utf8");
        if (!options.force) { console.log(`  skip ${path.basename(p)} (already exists)`); return; }
      } catch { /* file doesn't exist, write it */ }
      await fs.writeFile(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      console.log(`  created ${path.basename(p)}`);
    };

    console.log(`Initializing .oracle/ in ${root}`);
    await writeIf(policyPath, defaultPolicy);
    await writeIf(configPath, defaultConfig);
    console.log("  created docs/");
    console.log("  created skills/");
    console.log("Done.");
  });

// ── identity ────────────────────────────────────────────────────
const identityCmd = program.command("identity").description("Manage your personal identity");

identityCmd
  .command("show")
  .description("Show identity profile")
  .action(async () => {
    const store = new ProfileStore(homeDir());
    const identity = await store.getIdentity();
    const persona = await store.getPersona();
    console.log("Persona:", JSON.stringify(persona, null, 2));
    console.log("Identity:", JSON.stringify(identity ?? "not set", null, 2));
  });

identityCmd
  .command("awareness")
  .description("Show Oracle's current identity, operating context, capabilities, and boundaries")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadProjectConfig(cwd);
    const requestedModel =
      config.provider === "browser" ? config.browser.model : config.model;
    const route = resolveProviderRoute({
      model: requestedModel,
      selection: config.provider,
      selectionSource: "project-config",
      config
    });
    const awareness = await new ProfileStore(homeDir()).getAwareness({
      workspaceRoot: cwd,
      interface: "cli",
      backend: route.provider
    });
    console.log(JSON.stringify(awareness, null, 2));
  });

identityCmd
  .command("setup")
  .description("Set up your identity profile")
  .requiredOption("-n, --name <name>", "Your name")
  .option("--title <title>", "Your title")
  .option("--role <role>", "Your role")
  .option("-d, --description <text>", "About you")
  .option("--prefs <items>", "Preferences (comma-separated)")
  .option("--habits <items>", "Habits (comma-separated)")
  .option("--goals <items>", "Goals (comma-separated)")
  .action(async (options) => {
    const store = new ProfileStore(homeDir());
    await store.saveIdentity({
      name: options.name,
      title: options.title,
      role: options.role,
      description: options.description,
      preferences: options.prefs?.split(",").map((s: string) => s.trim()),
      habits: options.habits?.split(",").map((s: string) => s.trim()),
      goals: options.goals?.split(",").map((s: string) => s.trim())
    });
    console.log(`Identity saved for ${options.name}. Every consult now knows who you are.`);
  });

identityCmd
  .command("persona")
  .description("Set Oracle's voice/personality")
  .option("--name <name>", "Oracle's name", "Oracle")
  .option("--tone <tone>", "professional | casual | friendly | witty", "professional")
  .option("--style <text>", "Custom style description")
  .option("--greeting <text>", "Greeting message")
  .action(async (options) => {
    const store = new ProfileStore(homeDir());
    await store.savePersona({
      name: options.name,
      tone: options.tone,
      style: options.style,
      greeting: options.greeting
    });
    console.log(`Persona saved: ${options.name}`);
  });

identityCmd
  .command("forget")
  .description("Clear your identity profile")
  .action(async () => {
    const store = new ProfileStore(homeDir());
    await store.saveIdentity({ name: "" });
    console.log("Identity cleared.");
  });

// ── github ────────────────────────────────────────────────────
const githubCmd = program.command("github").description("GitHub integration via gh CLI");

githubCmd
  .command("check")
  .description("Check gh CLI installation and authentication")
  .action(() => {
    const inst = gh.checkGh();
    if (!inst.ok) {
      console.error("gh CLI not found. Install from https://cli.github.com/");
      process.exitCode = 1;
      return;
    }
    console.log(`gh: ${inst.version}`);
    const auth = gh.checkGhAuth();
    if (auth.ok) {
      console.log(`Authenticated as: ${auth.user}`);
    } else {
      console.error(`Not authenticated: ${auth.error}`);
      console.error("Run: gh auth login");
      process.exitCode = 1;
    }
  });

githubCmd
  .command("pr")
  .description("Pull request operations")
  .argument("<action>", "list | view | diff | files | review | comment | approve | request-changes")
  .argument("[number]", "PR number (required for view/diff/files/review/comment/approve/request-changes)")
  .option("-R, --repo <repo>", "Repository (owner/repo)")
  .option("-s, --state <state>", "PR state filter: open | closed | merged | all (default: open)")
  .option("-b, --body <text>", "Comment/review body")
  .option("--base <branch>", "Filter by base branch")
  .option("--head <branch>", "Filter by head branch")
  .option("-n, --limit <number>", "Max results", "30")
  .option("--author <author>", "Filter by author")
  .option("--label <labels>", "Filter by labels (comma-separated)")
  .action(async (action: string, number: string, options) => {
    const repo = options.repo ?? gh.inferRepo(options.cwd ?? process.cwd());
    const num = number ? Number(number) : undefined;
    switch (action) {
      case "list": {
        const prs = gh.listPRs({
          repo,
          state: options.state as any,
          limit: Number(options.limit),
          base: options.base,
          head: options.head,
          author: options.author,
          labels: options.label?.split(","),
        });
        if (!prs.length) { console.log("No PRs found."); return; }
        for (const pr of prs) {
          const s = pr.state === "open" ? "\x1b[32mopen\x1b[0m" : pr.state === "merged" ? "\x1b[35mmerged\x1b[0m" : "\x1b[31mclosed\x1b[0m";
          console.log(`#${String(pr.number).padEnd(4)} ${s}  ${pr.title}`);
        }
        break;
      }
      case "view":
        if (!num) throw new Error("PR number required");
        {
          const pr = gh.getPR(num, repo);
          console.log(`#${pr.number} ${pr.title}`);
          console.log(`State: ${pr.state}  Author: ${pr.author}`);
          console.log(`Base: ${pr.baseRef} ← Head: ${pr.headRef}`);
          console.log(`Created: ${pr.createdAt.slice(0, 10)}`);
          if (pr.body) console.log(`\n${pr.body.slice(0, 2000)}`);
        }
        break;
      case "diff":
        if (!num) throw new Error("PR number required");
        console.log(gh.getPRDiff(num, repo));
        break;
      case "files":
        if (!num) throw new Error("PR number required");
        {
          const files = gh.getPRFiles(num, repo);
          let add = 0, del = 0;
          for (const f of files) { add += f.additions; del += f.deletions; }
          console.log(`${files.length} file(s), +${add} -${del}\n`);
          for (const f of files) {
            const icon = f.status === "added" ? "\x1b[32m+\x1b[0m" : f.status === "removed" ? "\x1b[31m-\x1b[0m" : f.status === "renamed" ? "\x1b[33m→\x1b[0m" : "\x1b[34m~\x1b[0m";
            console.log(` ${icon} ${f.path}  (+${f.additions}, -${f.deletions})`);
          }
        }
        break;
      case "review":
        if (!num) throw new Error("PR number required");
        {
          const pr = gh.getPR(num, repo);
          const diff = gh.getPRDiff(num, repo);
          const files = gh.getPRFiles(num, repo);
          console.log(`\nReviewing PR #${num}: ${pr.title}`);
          console.log(`Repository: ${repo ?? "unknown"}`);
          console.log(`Files: ${files.length}, Diff: ${(diff.length / 1024).toFixed(1)}KB\n`);

          const fileList = files.map((f: PRFile) => `  ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`).join("\n");
          const reviewPrompt = [
            `## PR Review: #${num} — ${pr.title}`,
            `**Author:** ${pr.author}  **Repo:** ${repo}`,
            `**Base:** ${pr.baseRef} ← **Head:** ${pr.headRef}`,
            "",
            pr.body ? `### Description\n${pr.body}\n` : "",
            `### Changed Files (${files.length})`,
            fileList,
            "",
            "### Diff",
            "```diff",
            diff.slice(0, 50000),
            "```",
            "",
            "Review this PR for correctness, edge cases, security, and maintainability.",
            "Be specific — cite line numbers from the diff.",
          ].filter(Boolean).join("\n");

          const { ConsultService } = await import("./core/consult.js");
          const { createProvider, parseProviderName } = await import("./providers/factory.js");
          const providerName = options.provider ?? "codex";
          const parsedProvider = parseProviderName(providerName);
          const checks = await (await import("./providers/factory.js")).checkProvider(parsedProvider);
          const failedCheck = checks.find((chk: any) => !chk.ok);
          if (failedCheck) throw new Error(`${failedCheck.name}: ${failedCheck.detail}`);

          const service = new ConsultService(createProvider(parsedProvider));
          const result = await service.consult({
            prompt: reviewPrompt,
            preset: "review",
            provider: providerName,
            model: options.model ?? "gpt-5.4",
            cwd: options.cwd ?? process.cwd(),
            systemPrompt: "You are a senior code reviewer. Analyze the PR diff and files. Be specific, cite line numbers, and categorize findings by severity (critical/major/minor/nit). End with a verdict: approve, request changes, or comment.",
            allowEmptyFiles: true,
          });

          console.log(`\n${result.output}`);
          if (options.body) {
            gh.submitPRReview(num, options.body, "COMMENT", repo);
            console.log("\nReview posted as comment.");
          }
        }
        break;
      case "comment":
        if (!num) throw new Error("PR number required");
        if (!options.body) throw new Error("Comment body required (-b)");
        gh.createComment(num, options.body, repo);
        console.log("Comment posted.");
        break;
      case "approve":
        if (!num) throw new Error("PR number required");
        gh.submitPRReview(num, options.body ?? "LGTM.", "APPROVE", repo);
        console.log("PR approved.");
        break;
      case "request-changes":
        if (!num) throw new Error("PR number required");
        if (!options.body) throw new Error("Review body required (-b) for request-changes");
        gh.submitPRReview(num, options.body, "REQUEST_CHANGES", repo);
        console.log("Changes requested.");
        break;
      default:
        throw new Error(`Unknown action: ${action}. Use: list, view, diff, files, review, comment, approve, request-changes`);
    }
  });

githubCmd
  .command("issue")
  .description("Issue operations")
  .argument("<action>", "list | view | comment")
  .argument("[number]", "Issue number (required for view/comment)")
  .option("-R, --repo <repo>", "Repository (owner/repo)")
  .option("-s, --state <state>", "Issue state filter: open | closed | all (default: open)")
  .option("-b, --body <text>", "Comment body")
  .option("-n, --limit <number>", "Max results", "30")
  .option("--author <author>", "Filter by author")
  .option("--label <labels>", "Filter by labels (comma-separated)")
  .action(async (action: string, number: string, options) => {
    const repo = options.repo ?? gh.inferRepo(options.cwd ?? process.cwd());
    const num = number ? Number(number) : undefined;
    switch (action) {
      case "list": {
        const issues = gh.listIssues({
          repo,
          state: options.state as any,
          limit: Number(options.limit),
          author: options.author,
          labels: options.label?.split(","),
        });
        if (!issues.length) { console.log("No issues found."); return; }
        for (const i of issues) {
          const s = i.state === "open" ? "\x1b[32mopen\x1b[0m" : "\x1b[31mclosed\x1b[0m";
          console.log(`#${String(i.number).padEnd(4)} ${s}  ${i.title}`);
        }
        break;
      }
      case "view":
        if (!num) throw new Error("Issue number required");
        {
          const i = gh.getIssue(num, repo);
          console.log(`#${i.number} ${i.title}`);
          console.log(`State: ${i.state}  Author: ${i.author}`);
          console.log(`Created: ${i.createdAt.slice(0, 10)}`);
          if (i.body) console.log(`\n${i.body.slice(0, 2000)}`);
        }
        break;
      case "comment":
        if (!num) throw new Error("Issue number required");
        if (!options.body) throw new Error("Comment body required (-b)");
        gh.createComment(num, options.body, repo);
        console.log("Comment posted.");
        break;
      default:
        throw new Error(`Unknown action: ${action}. Use: list, view, comment`);
    }
  });

githubCmd
  .command("search")
  .description("Search GitHub code")
  .argument("<query>", "Search query")
  .option("-n, --limit <number>", "Max results", "10")
  .action(async (query: string, options) => {
    const results = gh.searchCode(query, Number(options.limit));
    for (const r of results) {
      console.log(`${r.repo}:${r.path}`);
      for (const m of r.matches) {
        console.log(`  ${m.slice(0, 200)}`);
      }
    }
  });

githubCmd
  .command("get")
  .description("Raw GitHub API GET request")
  .argument("<endpoint>", "API endpoint (e.g. /repos/owner/repo)")
  .action(async (endpoint: string) => {
    const result = gh.apiRequest(endpoint);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("governance")
  .alias("actb")
  .description("Display ACTB Governance Framework status and policy metrics")
  .option("--json", "Output structured JSON report")
  .action(async (options) => {
    const engine = new ACTBEngine(process.cwd());
    const report = engine.getAwarenessReport();
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("=== ACTB Governance Framework Report ===");
      console.log(`Timestamp:       ${report.timestamp}`);
      console.log(`Workspace:       ${report.workspaceRoot}`);
      console.log(`Status:          ${report.status.toUpperCase()}`);
      console.log(`Awareness Engine: Active (Audit Trail Enabled)`);
      console.log(`Control Engine:   Active (Step Ceiling & Approval Policy)`);
      console.log(`Transform Engine: Active (Memory Deduplication)`);
      console.log(`Boundary Engine:  Active (Workspace Path Confinement)`);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // A rejected command action would otherwise surface as a top-level
  // unhandled rejection: Node prints the raw stack and, because orchestrated
  // commands may leave an MCP HTTP transport/socket handle open, aborts with
  // a libuv "UV_HANDLE_CLOSING" assertion instead of a clean exit. Convert it
  // into a friendly one-line error and a non-zero exit. MCP errors from a
  // sidecar failures are expected user-facing conditions, not crashes.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  // Set exitCode and let the event loop drain instead of calling
  // process.exit(): a synchronous exit while an MCP streamable-http handle is
  // still tearing down triggers a libuv "UV_HANDLE_CLOSING" assertion on
  // Windows. Command actions close their adapters in a `finally`, so the loop
  // has nothing left to keep it alive and exits cleanly with this code.
  process.exitCode = 1;
}
