import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { AnthropicProvider } from "./anthropic.js";
import { CodexCliProvider, runCommand, type CommandRunner } from "./codex.js";
import { OpenAIProvider, OpenCodeProvider } from "./openai.js";
import { GeminiProvider, GEMINI_MODELS } from "./gemini.js";
import { ChatGptBrowserBackend } from "../backends/chatgpt-browser/backend.js";
import { findChromeExecutable } from "../backends/chatgpt-browser/chrome.js";
import type { ChatGptBrowserConfig } from "../backends/chatgpt-browser/types.js";
import { TokenStore } from "../auth/store.js";
import { AnthropicOAuthClient } from "../auth/anthropic-oauth.js";
import type { DoctorCheck } from "../backends/backend.js";
import type { AgentProvider } from "../agent/types.js";

/** Mirrors the CLI's home-directory resolution so both read the same tokens. */
export function oracleHomeDir(): string {
  return process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
}

export interface OAuthSessionStatus {
  present: boolean;
  expired: boolean;
  /** An expired session with a refresh token still recovers without a re-login. */
  refreshable: boolean;
  planTier?: string;
}

/** Inspect the stored Anthropic OAuth session without performing a refresh. */
export async function readAnthropicOAuthSession(
  homeDir = oracleHomeDir()
): Promise<OAuthSessionStatus> {
  const entry = await new TokenStore(homeDir).read("anthropic");
  if (!entry) return { present: false, expired: false, refreshable: false };
  const expired = Boolean(entry.expiresAt && Date.now() >= entry.expiresAt);
  return {
    present: true,
    expired,
    refreshable: Boolean(entry.refreshToken),
    planTier: entry.planTier,
  };
}

export type BackendName = "codex" | "openai" | "anthropic" | "opencode" | "gemini" | "chatgpt-browser";

/** @deprecated Use `BackendName` instead. */
export type ProviderName = BackendName;

const BACKEND_NAMES: readonly BackendName[] = ["codex", "openai", "anthropic", "opencode", "gemini", "chatgpt-browser"];

export interface CheckBackendOptions {
  runner?: CommandRunner;
  homeDir?: string;
  /** Whether experimental browser mode is enabled in project config. */
  experimentalBrowserMode?: boolean;
  browser?: Partial<Omit<ChatGptBrowserConfig, "enabled">>;
}

export interface CreateExecutionBackendOptions {
  homeDir?: string;
  experimentalBrowserMode?: boolean;
  browser?: Partial<Omit<ChatGptBrowserConfig, "enabled">>;
}

export function parseBackendName(value = "codex"): BackendName {
  if ((BACKEND_NAMES as readonly string[]).includes(value)) return value as BackendName;
  throw new Error(`Unknown backend: ${value}. Expected ${BACKEND_NAMES.join(", ")}.`);
}

/** @deprecated Use `parseBackendName` instead. */
export function parseProviderName(value = "codex"): BackendName {
  return parseBackendName(value);
}

/**
 * Build an Anthropic backend that can authenticate either way.
 *
 * The OAuth client must be supplied here: `AnthropicProvider` only consults
 * OAuth when it is handed a client, so constructing it bare made every stored
 * `oracle login` session unreachable and the bearer-token path dead code.
 *
 * The client id may be empty — a stored session records its own, and the
 * client resolves it from there when refreshing.
 */
function createAnthropicBackend(): AnthropicProvider {
  const oauth = new AnthropicOAuthClient(
    process.env.ANTHROPIC_CLIENT_ID ?? "",
    new TokenStore(oracleHomeDir())
  );
  return new AnthropicProvider(process.env.ANTHROPIC_API_KEY, oauth);
}

export function createExecutionBackend(
  name: BackendName = "codex",
  options: CreateExecutionBackendOptions = {}
): import("../backends/backend.js").ExecutionBackend {
  switch (name) {
    case "anthropic": return createAnthropicBackend();
    case "openai": return new OpenAIProvider();
    case "opencode": return new OpenCodeProvider();
    case "gemini": return new GeminiProvider();
    case "chatgpt-browser":
      return new ChatGptBrowserBackend({
        profileDir: options.browser?.profileDir
          ?? path.join(options.homeDir ?? oracleHomeDir(), "chrome-profile"),
        enabled: options.experimentalBrowserMode ?? false,
        headed: true,
        timeoutMs: options.browser?.timeoutMs
      });
    default: return new CodexCliProvider();
  }
}

/** @deprecated Use `createExecutionBackend` instead. */
export function createProvider(
  name: BackendName = "codex",
  options: CreateExecutionBackendOptions = {}
): import("../backends/backend.js").ExecutionBackend {
  return createExecutionBackend(name, options);
}

/** Models each backend serves, for `oracle models list`. */
export const BACKEND_MODELS: Record<BackendName, readonly string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini"],
  gemini: GEMINI_MODELS,
  opencode: ["(any OpenAI-compatible model via OPENCODE_MODEL)"],
  codex: ["(whatever the local codex CLI is logged into)"],
  "chatgpt-browser": ["(whatever the logged-in ChatGPT account can use)"],
};

/** @deprecated Use `BACKEND_MODELS` instead. */
export const PROVIDER_MODELS = BACKEND_MODELS;

/**
 * Which backends are usable right now, based on credentials in the environment.
 * `codex` is excluded: it depends on a CLI binary and login state, which only
 * `checkBackend` can determine, and it does so by shelling out.
 */
export function detectAvailableBackends(env: NodeJS.ProcessEnv = process.env): BackendName[] {
  const available: BackendName[] = [];
  if (env.ANTHROPIC_API_KEY) available.push("anthropic");
  if (env.OPENAI_API_KEY) available.push("openai");
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) available.push("gemini");
  if (env.OPENCODE_API_KEY || (env.OPENAI_API_KEY && env.OPENCODE_API_BASE)) available.push("opencode");
  return available;
}

/** @deprecated Use `detectAvailableBackends` instead. */
export function detectAvailableProviders(env: NodeJS.ProcessEnv = process.env): BackendName[] {
  return detectAvailableBackends(env);
}

/**
 * Route a model name to the backend that serves it.
 * Returns null when the name matches no known family, so callers can decide
 * whether to error or fall back rather than being handed a wrong backend.
 */
export function backendForModel(model: string): BackendName | null {
  const name = model.toLowerCase();
  if (name.startsWith("claude")) return "anthropic";
  if (name.startsWith("gemini")) return "gemini";
  if (name.startsWith("gpt") || name.startsWith("o1") || name.startsWith("o3")) return "openai";
  return null;
}

/** @deprecated Use `backendForModel` instead. */
export function providerForModel(model: string): BackendName | null {
  return backendForModel(model);
}

/** Backends that implement the agentic tool-use loop (read/write/bash). */
export const AGENT_BACKENDS: readonly BackendName[] = ["anthropic", "opencode", "codex"];

/** @deprecated Use `AGENT_BACKENDS` instead. */
export const AGENT_PROVIDERS = AGENT_BACKENDS;

/**
 * Create a tool-capable backend for the agentic loop. Supports:
 * - `anthropic` — Anthropic SDK (Claude)
 * - `opencode` — OpenAI-compatible (OpenRouter, Groq, local LLMs) with native function calling
 * - `codex` — Codex CLI via text-based tool calling through `codex exec`
 */
export function createAgentBackend(name: BackendName): AgentProvider {
  switch (name) {
    case "anthropic": return createAnthropicBackend();
    case "opencode": return new OpenCodeProvider();
    case "codex": return new CodexCliProvider();
    default:
      throw new Error(
        `Backend '${name}' does not support agentic tool use. ` +
          `Set backend to 'anthropic', 'opencode', or 'codex'.`
      );
  }
}

/** @deprecated Use `createAgentBackend` instead. */
export function createAgentProvider(name: BackendName): AgentProvider {
  return createAgentBackend(name);
}

async function checkChatGptBrowser(
  homeDir: string,
  experimentalEnabled: boolean,
  browser: CheckBackendOptions["browser"]
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const supported: NodeJS.Platform[] = ["darwin", "linux", "win32"];
  const isSupported = supported.includes(process.platform);
  checks.push({
    name: "platform",
    ok: isSupported,
    detail: isSupported ? process.platform : `unsupported platform: ${process.platform}`
  });

  const chrome = await findChromeExecutable();
  checks.push({
    name: "chrome executable",
    ok: Boolean(chrome),
    detail: chrome ?? "Google Chrome not found"
  });

  const profileDir = browser?.profileDir ?? path.join(homeDir, "chrome-profile");
  let profileReady = false;
  try {
    const stat = await fs.stat(profileDir);
    profileReady = stat.isDirectory();
  } catch {
    profileReady = false;
  }
  checks.push({
    name: "oracle chrome profile",
    ok: profileReady,
    detail: profileReady ? profileDir : `run \`oracle browser setup\` to create ${profileDir}`
  });

  checks.push({
    name: "experimental.browserMode",
    ok: experimentalEnabled,
    detail: experimentalEnabled
      ? "enabled"
      : "set experimental.browserMode to true in .oracle/config.json"
  });

  return checks;
}

export async function checkBackend(
  name: BackendName,
  options: CheckBackendOptions = {}
): Promise<DoctorCheck[]> {
  const runner = options.runner ?? runCommand;

  if (name === "chatgpt-browser") {
    return checkChatGptBrowser(
      options.homeDir ?? oracleHomeDir(),
      options.experimentalBrowserMode ?? false,
      options.browser
    );
  }

  if (name === "openai") {
    return [
      { name: "OPENAI_API_KEY", ok: Boolean(process.env.OPENAI_API_KEY), detail: process.env.OPENAI_API_KEY ? "set" : "not set" },
      { name: "OPENAI_API_BASE", ok: Boolean(process.env.OPENAI_API_BASE), detail: process.env.OPENAI_API_BASE ?? "default (api.openai.com)" },
    ];
  }

  if (name === "anthropic") {
    // Either credential is sufficient. Checking only the env var made a
    // successful `oracle login` useless: the backend authenticates fine over
    // OAuth, but this gate rejected the call before it ever got there.
    if (process.env.ANTHROPIC_API_KEY) {
      return [{ name: "anthropic credentials", ok: true, detail: "ANTHROPIC_API_KEY set" }];
    }
    const session = await readAnthropicOAuthSession(options.homeDir);
    if (session.present) {
      // An expired session that still holds a refresh token is usable — the
      // backend renews it on first call. Only an expired session with nothing
      // to refresh from actually requires the user to log in again.
      const usable = !session.expired || session.refreshable;
      const detail = !session.expired
        ? `OAuth session (plan: ${session.planTier ?? "api"})`
        : session.refreshable
          ? "OAuth session expired, refreshes on next use"
          : "OAuth session expired — run `oracle login --provider anthropic`";
      return [{ name: "anthropic credentials", ok: usable, detail }];
    }
    return [
      {
        name: "anthropic credentials",
        ok: false,
        detail: "no ANTHROPIC_API_KEY and no OAuth session — run `oracle login --provider anthropic`",
      },
    ];
  }

  if (name === "gemini") {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    return [
      {
        name: "GEMINI_API_KEY",
        ok: Boolean(key),
        detail: process.env.GEMINI_API_KEY
          ? "set"
          : process.env.GOOGLE_API_KEY
            ? "set (GOOGLE_API_KEY)"
            : "not set",
      },
      {
        name: "GEMINI_API_BASE",
        ok: true,
        detail: process.env.GEMINI_API_BASE ?? "default (generativelanguage.googleapis.com)",
      },
    ];
  }

  if (name === "opencode") {
    return [
      { name: "OPENCODE_API_KEY", ok: Boolean(process.env.OPENCODE_API_KEY ?? process.env.OPENAI_API_KEY), detail: process.env.OPENCODE_API_KEY ? "set (OPENCODE_API_KEY)" : process.env.OPENAI_API_KEY ? "set (OPENAI_API_KEY)" : "not set" },
      { name: "OPENCODE_API_BASE", ok: Boolean(process.env.OPENCODE_API_BASE), detail: process.env.OPENCODE_API_BASE ?? "not set" },
      { name: "OPENCODE_MODEL", ok: Boolean(process.env.OPENCODE_MODEL), detail: process.env.OPENCODE_MODEL ?? "default (gpt-4o)" },
    ];
  }

  try {
    const version = await runner("codex", ["--version"], {});
    if (version.exitCode !== 0) {
      return [{ name: "codex executable", ok: false, detail: version.stderr.trim() }];
    }
    const login = await runner("codex", ["login", "status"], {});
    return [
      { name: "codex executable", ok: true, detail: version.stdout.trim() },
      {
        name: "codex authentication",
        ok: login.exitCode === 0,
        detail: (login.stdout || login.stderr).trim()
      }
    ];
  } catch (error) {
    return [
      {
        name: "codex executable",
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    ];
  }
}

/** @deprecated Use `checkBackend` instead. */
export async function checkProvider(
  name: BackendName,
  runner: CommandRunner = runCommand
): Promise<DoctorCheck[]> {
  return checkBackend(name, { runner });
}
