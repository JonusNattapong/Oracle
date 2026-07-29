import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexCliProvider } from "./codex.js";
import {
  createExecutionBackend,
  createProvider,
  createAgentProvider,
  checkProvider,
  readAnthropicOAuthSession
} from "./factory.js";
import { TokenStore } from "../auth/store.js";

describe("provider factory", () => {
  test("creates Codex by default", () => {
    expect(createProvider()).toBeInstanceOf(CodexCliProvider);
  });

  test("reports Codex version and login readiness", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "codex-cli 0.144.4", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" });

    await expect(checkProvider("codex", runner)).resolves.toEqual([
      { name: "codex executable", ok: true, detail: "codex-cli 0.144.4" },
      { name: "codex authentication", ok: true, detail: "Logged in using ChatGPT" }
    ]);
  });

  test("passes the experimental opt-in into the ChatGPT browser backend", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-browser-factory-"));
    try {
      const backend = createExecutionBackend("chatgpt-browser", {
        homeDir: home,
        experimentalBrowserMode: true,
        browser: { profileDir: home }
      });
      const checks = await backend.healthCheck();
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "experimental.browserMode",
            ok: true
          })
        ])
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("checkProvider('anthropic') credential detection", () => {
  let home: string;
  let store: TokenStore;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-factory-auth-"));
    store = new TokenStore(home);
    vi.stubEnv("ORACLE_HOME_DIR", home);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  test("an API key alone is sufficient", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const [check] = await checkProvider("anthropic");
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/ANTHROPIC_API_KEY/);
  });

  test("an OAuth session alone is sufficient", async () => {
    // The whole point of `oracle login`: authenticating must not still require
    // the API key it replaces.
    await store.write("anthropic", { accessToken: "at", expiresAt: Date.now() + 60_000, planTier: "max" });
    const [check] = await checkProvider("anthropic");
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/max/);
  });

  test("an expired session that can refresh is still usable", async () => {
    await store.write("anthropic", {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() - 1000,
    });
    const [check] = await checkProvider("anthropic");
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/refresh/i);
  });

  test("an expired session with nothing to refresh from fails", async () => {
    await store.write("anthropic", { accessToken: "at", expiresAt: Date.now() - 1000 });
    const [check] = await checkProvider("anthropic");
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/oracle login/);
  });

  test("no credentials at all fails with actionable guidance", async () => {
    const [check] = await checkProvider("anthropic");
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/oracle login/);
  });
});

describe("createProvider wires OAuth into the Anthropic provider", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-wiring-"));
    vi.stubEnv("ORACLE_HOME_DIR", home);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_CLIENT_ID", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  test("constructs without an API key when a session exists", async () => {
    // Regression guard: the factory used to call `new AnthropicProvider()`
    // with no OAuth client, so `oracle login` stored a token that nothing
    // could ever read and the bearer-token path was unreachable.
    await new TokenStore(home).write("anthropic", {
      accessToken: "at",
      expiresAt: Date.now() + 60_000,
    });
    expect(() => createProvider("anthropic")).not.toThrow();
    expect(() => createAgentProvider("anthropic")).not.toThrow();
  });

  test("constructs with neither credential, deferring the error to call time", async () => {
    // Construction must not throw here — `oracle login` itself has to be
    // runnable on a machine that has no credentials yet.
    expect(() => createProvider("anthropic")).not.toThrow();
  });
});

describe("readAnthropicOAuthSession", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-session-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  test("reports absence without throwing", async () => {
    expect(await readAnthropicOAuthSession(home)).toEqual({
      present: false,
      expired: false,
      refreshable: false,
    });
  });

  test("reports expiry and refreshability", async () => {
    await new TokenStore(home).write("anthropic", {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() - 1,
      planTier: "pro",
    });
    expect(await readAnthropicOAuthSession(home)).toEqual({
      present: true,
      expired: true,
      refreshable: true,
      planTier: "pro",
    });
  });

  test("a session without an expiry is treated as live, not expired", async () => {
    await new TokenStore(home).write("anthropic", { accessToken: "at" });
    const session = await readAnthropicOAuthSession(home);
    expect(session.present).toBe(true);
    expect(session.expired).toBe(false);
  });
});
