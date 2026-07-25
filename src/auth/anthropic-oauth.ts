import { TokenStore } from "./store.js";

const AUTH_BASE = "https://auth.anthropic.com";

/** Anthropic subscription tier tied to an OAuth session. "api" = pay-per-token API key/OAuth with no subscription. */
export type PlanTier = "api" | "pro" | "max";

/**
 * Best-effort tier extraction from an OAuth access token's JWT claims.
 * Not signature-verified — used only as a client-side routing/UX hint, never
 * for authorization decisions (the API itself enforces entitlements).
 */
function decodePlanTier(accessToken: string): PlanTier {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return "api";
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const raw = String(
      payload.subscription_type ?? payload.plan ?? payload.tier ?? payload.plan_type ?? ""
    ).toLowerCase();
    if (raw.includes("max")) return "max";
    if (raw.includes("pro")) return "pro";
    return "api";
  } catch {
    return "api";
  }
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}

async function post(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export interface DeviceFlowSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

export class AnthropicOAuthClient {
  // Single-flight guard: dedupes concurrent refreshes triggered within this
  // process (e.g. parallel provider calls) onto one network request.
  private refreshInFlight: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly store: TokenStore
  ) {}

  /**
   * The client id to authenticate with. A provider constructed from the
   * factory has no id to hand in, so fall back to the one recorded at login;
   * without this, refresh would fail in any shell that lacks the env var.
   */
  private async resolveClientId(): Promise<string> {
    if (this.clientId) return this.clientId;
    const entry = await this.store.read("anthropic");
    const stored = entry?.clientId;
    if (!stored) {
      throw new Error(
        "No OAuth client id available. Set ANTHROPIC_CLIENT_ID or run `oracle login --provider anthropic --client-id <id>`."
      );
    }
    return stored;
  }

  async getValidToken(): Promise<string | null> {
    const entry = await this.store.read("anthropic");
    if (!entry) return null;
    if (entry.expiresAt && Date.now() >= entry.expiresAt) {
      if (entry.refreshToken) return this.refresh(entry.refreshToken);
      return null;
    }
    return entry.accessToken;
  }

  /** Returns the subscription tier for the current session, refreshing the token first if needed. */
  async getPlanTier(): Promise<PlanTier> {
    const token = await this.getValidToken();
    if (!token) return "api";
    const entry = await this.store.read("anthropic");
    return (entry?.planTier as PlanTier | undefined) ?? decodePlanTier(token);
  }

  async startDeviceFlow(): Promise<DeviceFlowSession> {
    const res = await post("/oauth/device/code", {
      client_id: this.clientId,
      scope: "api"
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth device code request failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as DeviceCodeResponse;
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      interval: data.interval || 5
    };
  }

  async pollForToken(deviceCode: string, interval: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error("Login cancelled.");
      await new Promise((r) => setTimeout(r, interval * 1000));
      const res = await post("/oauth/token", {
        client_id: this.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      });
      if (res.ok) {
        const data = (await res.json()) as TokenResponse;
        await this.store.write("anthropic", {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
          planTier: decodePlanTier(data.access_token),
          clientId: this.clientId
        });
        return;
      }
      // authorization_pending is normal, keep polling
      if (res.status === 400) {
        const body = (await res.json()) as { error?: string };
        if (body.error === "authorization_pending") continue;
        if (body.error === "slow_down") {
          interval += 5;
          continue;
        }
        throw new Error(`OAuth token request failed: ${body.error ?? (await res.text())}`);
      }
      throw new Error(`OAuth token request failed (${res.status}): ${await res.text()}`);
    }
  }

  async logout(): Promise<void> {
    await this.store.delete("anthropic");
  }

  /**
   * Refresh tokens are typically single-use — if another `oracle` process
   * refreshed concurrently, our refresh_token is already burned and the
   * network call would 400/401. Guard against that in two layers:
   * 1. In-process: concurrent callers share one in-flight refresh.
   * 2. Cross-process: re-read the token file first; if it already carries a
   *    non-expired access token newer than what we started with, another
   *    process beat us to it — adopt its result instead of refreshing again.
   */
  private async refresh(refreshToken: string): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh(refreshToken);
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async doRefresh(refreshToken: string): Promise<string> {
    const onDisk = await this.store.read("anthropic");
    if (onDisk && onDisk.refreshToken !== refreshToken && onDisk.expiresAt && Date.now() < onDisk.expiresAt) {
      // Another process already rotated the refresh token and wrote a fresh
      // access token — use it instead of racing a second refresh call.
      return onDisk.accessToken;
    }

    const res = await post("/oauth/token", {
      client_id: await this.resolveClientId(),
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    });
    if (!res.ok) {
      // The refresh call failed — before giving up, check whether a sibling
      // process already refreshed and wrote a valid token while we were in
      // flight (this is the common cause of a 400 invalid_grant here).
      const latest = await this.store.read("anthropic");
      if (latest && latest.refreshToken !== refreshToken && latest.expiresAt && Date.now() < latest.expiresAt) {
        return latest.accessToken;
      }
      await this.store.delete("anthropic");
      throw new Error(`Token refresh failed (${res.status}), run "oracle login" again.`);
    }
    const data = (await res.json()) as TokenResponse;
    await this.store.write("anthropic", {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      planTier: decodePlanTier(data.access_token),
      clientId: this.clientId || onDisk?.clientId
    });
    return data.access_token;
  }
}
