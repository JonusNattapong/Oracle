import os from "node:os";
import path from "node:path";
import { AnthropicProvider } from "./anthropic.js";
import { CodexCliProvider, runCommand, type CommandRunner } from "./codex.js";
import { OpenAIProvider, OpenCodeProvider } from "./openai.js";
import { GeminiProvider, GEMINI_MODELS } from "./gemini.js";
import { TokenStore } from "../auth/store.js";
import { AnthropicOAuthClient } from "../auth/anthropic-oauth.js";
import type { Provider } from "./provider.js";
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

export type ProviderName = "codex" | "openai" | "anthropic" | "opencode" | "gemini";

const PROVIDER_NAMES: readonly ProviderName[] = ["codex", "openai", "anthropic", "opencode", "gemini"];

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function parseProviderName(value = "codex"): ProviderName {
  if ((PROVIDER_NAMES as readonly string[]).includes(value)) return value as ProviderName;
  throw new Error(`Unknown provider: ${value}. Expected ${PROVIDER_NAMES.join(", ")}.`);
}

/**
 * Build an Anthropic provider that can authenticate either way.
 *
 * The OAuth client must be supplied here: `AnthropicProvider` only consults
 * OAuth when it is handed a client, so constructing it bare made every stored
 * `oracle login` session unreachable and the bearer-token path dead code.
 *
 * The client id may be empty — a stored session records its own, and the
 * client resolves it from there when refreshing.
 */
function createAnthropicProvider(): AnthropicProvider {
  const oauth = new AnthropicOAuthClient(
    process.env.ANTHROPIC_CLIENT_ID ?? "",
    new TokenStore(oracleHomeDir())
  );
  return new AnthropicProvider(process.env.ANTHROPIC_API_KEY, oauth);
}

export function createProvider(name: ProviderName = "codex"): Provider {
  switch (name) {
    case "anthropic": return createAnthropicProvider();
    case "openai": return new OpenAIProvider();
    case "opencode": return new OpenCodeProvider();
    case "gemini": return new GeminiProvider();
    default: return new CodexCliProvider();
  }
}

/** Models each provider serves, for `oracle models list`. */
export const PROVIDER_MODELS: Record<ProviderName, readonly string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini"],
  gemini: GEMINI_MODELS,
  opencode: ["(any OpenAI-compatible model via OPENCODE_MODEL)"],
  codex: ["(whatever the local codex CLI is logged into)"],
};

/**
 * Which providers are usable right now, based on credentials in the environment.
 * `codex` is excluded: it depends on a CLI binary and login state, which only
 * `checkProvider` can determine, and it does so by shelling out.
 */
export function detectAvailableProviders(env: NodeJS.ProcessEnv = process.env): ProviderName[] {
  const available: ProviderName[] = [];
  if (env.ANTHROPIC_API_KEY) available.push("anthropic");
  if (env.OPENAI_API_KEY) available.push("openai");
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) available.push("gemini");
  if (env.OPENCODE_API_KEY || (env.OPENAI_API_KEY && env.OPENCODE_API_BASE)) available.push("opencode");
  return available;
}

/**
 * Route a model name to the provider that serves it.
 * Returns null when the name matches no known family, so callers can decide
 * whether to error or fall back rather than being handed a wrong provider.
 */
export function providerForModel(model: string): ProviderName | null {
  const name = model.toLowerCase();
  if (name.startsWith("claude")) return "anthropic";
  if (name.startsWith("gemini")) return "gemini";
  if (name.startsWith("gpt") || name.startsWith("o1") || name.startsWith("o3")) return "openai";
  return null;
}

/** Providers that implement the agentic tool-use loop (read/write/bash). */
export const AGENT_PROVIDERS: readonly ProviderName[] = ["anthropic", "opencode", "codex"];

/**
 * Create a tool-capable provider for the agentic loop. Supports:
 * - `anthropic` — Anthropic SDK (Claude)
 * - `opencode` — OpenAI-compatible (OpenRouter, Groq, local LLMs) with native function calling
 * - `codex` — Codex CLI via text-based tool calling through `codex exec`
 */
export function createAgentProvider(name: ProviderName): AgentProvider {
  switch (name) {
    case "anthropic": return createAnthropicProvider();
    case "opencode": return new OpenCodeProvider();
    case "codex": return new CodexCliProvider();
    default:
      throw new Error(
        `Provider '${name}' does not support agentic tool use. ` +
          `Set provider to 'anthropic', 'opencode', or 'codex'.`
      );
  }
}

export async function checkProvider(
  name: ProviderName,
  runner: CommandRunner = runCommand
): Promise<DoctorCheck[]> {
  if (name === "openai") {
    return [
      { name: "OPENAI_API_KEY", ok: Boolean(process.env.OPENAI_API_KEY), detail: process.env.OPENAI_API_KEY ? "set" : "not set" },
      { name: "OPENAI_API_BASE", ok: Boolean(process.env.OPENAI_API_BASE), detail: process.env.OPENAI_API_BASE ?? "default (api.openai.com)" },
    ];
  }

  if (name === "anthropic") {
    // Either credential is sufficient. Checking only the env var made a
    // successful `oracle login` useless: the provider authenticates fine over
    // OAuth, but this gate rejected the call before it ever got there.
    if (process.env.ANTHROPIC_API_KEY) {
      return [{ name: "anthropic credentials", ok: true, detail: "ANTHROPIC_API_KEY set" }];
    }
    const session = await readAnthropicOAuthSession();
    if (session.present) {
      // An expired session that still holds a refresh token is usable — the
      // provider renews it on first call. Only an expired session with nothing
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
