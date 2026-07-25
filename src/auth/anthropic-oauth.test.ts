import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TokenStore } from "./store.js";
import { AnthropicOAuthClient } from "./anthropic-oauth.js";

/** Build an unsigned JWT whose payload carries the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("AnthropicOAuthClient", () => {
  let home: string;
  let store: TokenStore;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-oauth-"));
    store = new TokenStore(home);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  test("getValidToken returns null when there is no session", async () => {
    const client = new AnthropicOAuthClient("cid", store);
    expect(await client.getValidToken()).toBeNull();
  });

  test("returns a stored, unexpired token without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await store.write("anthropic", { accessToken: "live", expiresAt: Date.now() + 60_000 });

    const client = new AnthropicOAuthClient("cid", store);
    expect(await client.getValidToken()).toBe("live");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an expired token with no refresh token yields null rather than a stale token", async () => {
    await store.write("anthropic", { accessToken: "stale", expiresAt: Date.now() - 1000 });
    const client = new AnthropicOAuthClient("cid", store);
    expect(await client.getValidToken()).toBeNull();
  });

  test("refreshes an expired token and persists the rotated refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "new-at", refresh_token: "new-rt", expires_in: 3600, token_type: "Bearer" })
    ));
    await store.write("anthropic", { accessToken: "old", refreshToken: "old-rt", expiresAt: Date.now() - 1000 });

    const client = new AnthropicOAuthClient("cid", store);
    expect(await client.getValidToken()).toBe("new-at");

    const stored = await store.read("anthropic");
    expect(stored?.accessToken).toBe("new-at");
    expect(stored?.refreshToken).toBe("new-rt");
    expect(stored?.expiresAt).toBeGreaterThan(Date.now());
  });

  test("keeps the existing refresh token when the server does not rotate it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "new-at", expires_in: 3600, token_type: "Bearer" })
    ));
    await store.write("anthropic", { accessToken: "old", refreshToken: "keep-me", expiresAt: Date.now() - 1000 });

    const client = new AnthropicOAuthClient("cid", store);
    await client.getValidToken();
    expect((await store.read("anthropic"))?.refreshToken).toBe("keep-me");
  });

  test("concurrent refreshes share one network call", async () => {
    // Refresh tokens are typically single-use, so a second in-process call
    // would burn an already-spent token.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "at", refresh_token: "rt2", expires_in: 3600, token_type: "Bearer" })
    );
    vi.stubGlobal("fetch", fetchMock);
    await store.write("anthropic", { accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1000 });

    const client = new AnthropicOAuthClient("cid", store);
    const results = await Promise.all([
      client.getValidToken(),
      client.getValidToken(),
      client.getValidToken(),
    ]);

    expect(results).toEqual(["at", "at", "at"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("adopts a token another process already refreshed instead of racing it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // On-disk state carries a different refresh token and a live access token,
    // which is what a sibling process leaves behind after refreshing.
    await store.write("anthropic", {
      accessToken: "sibling-at",
      refreshToken: "rotated",
      expiresAt: Date.now() + 60_000,
    });

    const client = new AnthropicOAuthClient("cid", store);
    // Force the refresh path with the stale token this process still holds.
    const token = await (client as unknown as {
      doRefresh(rt: string): Promise<string>;
    }).doRefresh("stale-rt");

    expect(token).toBe("sibling-at");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a failed refresh clears the session and tells the user to log in again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_grant" })));
    await store.write("anthropic", { accessToken: "old", refreshToken: "dead", expiresAt: Date.now() - 1000 });

    const client = new AnthropicOAuthClient("cid", store);
    await expect(client.getValidToken()).rejects.toThrow(/oracle login/);
    expect(await store.read("anthropic")).toBeNull();
  });

  test("startDeviceFlow surfaces the user code and verification URI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(200, {
        device_code: "dc",
        user_code: "WXYZ-1234",
        verification_uri: "https://auth.anthropic.com/device",
        interval: 5,
        expires_in: 900,
      })
    ));

    const session = await new AnthropicOAuthClient("cid", store).startDeviceFlow();
    expect(session).toEqual({
      deviceCode: "dc",
      userCode: "WXYZ-1234",
      verificationUri: "https://auth.anthropic.com/device",
      interval: 5,
    });
  });

  test("startDeviceFlow raises on a rejected request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "bad client",
      json: async () => ({}),
    }));
    await expect(new AnthropicOAuthClient("bad", store).startDeviceFlow()).rejects.toThrow(/401/);
  });

  test("getPlanTier reads the tier recorded at login", async () => {
    await store.write("anthropic", {
      accessToken: "at",
      expiresAt: Date.now() + 60_000,
      planTier: "max",
    });
    expect(await new AnthropicOAuthClient("cid", store).getPlanTier()).toBe("max");
  });

  test("getPlanTier falls back to the token claims when none was recorded", async () => {
    await store.write("anthropic", {
      accessToken: jwt({ subscription_type: "pro" }),
      expiresAt: Date.now() + 60_000,
    });
    expect(await new AnthropicOAuthClient("cid", store).getPlanTier()).toBe("pro");
  });

  test("getPlanTier reports 'api' with no session and for opaque tokens", async () => {
    const client = new AnthropicOAuthClient("cid", store);
    expect(await client.getPlanTier()).toBe("api");

    await store.write("anthropic", { accessToken: "not-a-jwt", expiresAt: Date.now() + 60_000 });
    expect(await client.getPlanTier()).toBe("api");
  });

  test("records the client id at login so later shells can refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" })
    ));
    await new AnthropicOAuthClient("my-client", store).pollForToken("dc", 0);
    expect((await store.read("anthropic"))?.clientId).toBe("my-client");
  });

  test("refreshes using the stored client id when none was supplied", async () => {
    // A provider built by the factory has no client id to pass in; without the
    // stored fallback, refresh would fail in any shell lacking the env var.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "fresh", expires_in: 3600, token_type: "Bearer" })
    );
    vi.stubGlobal("fetch", fetchMock);
    await store.write("anthropic", {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 1000,
      clientId: "stored-client",
    });

    const client = new AnthropicOAuthClient("", store);
    expect(await client.getValidToken()).toBe("fresh");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).client_id).toBe("stored-client");
  });

  test("refresh without any client id fails with actionable guidance", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await store.write("anthropic", {
      accessToken: "old",
      refreshToken: "rt",
      expiresAt: Date.now() - 1000,
    });
    await expect(new AnthropicOAuthClient("", store).getValidToken()).rejects.toThrow(
      /ANTHROPIC_CLIENT_ID|--client-id/
    );
  });

  test("logout clears the stored session", async () => {
    await store.write("anthropic", { accessToken: "at" });
    await new AnthropicOAuthClient("cid", store).logout();
    expect(await store.read("anthropic")).toBeNull();
  });
});
