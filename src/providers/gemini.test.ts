import { describe, test, expect, vi, afterEach } from "vitest";
import { GeminiProvider, normalizeModel } from "./gemini.js";

const REQUEST: Parameters<GeminiProvider["run"]>[0] = {
  model: "gemini-2.0-flash",
  systemPrompt: "You are terse.",
  userPrompt: "Say hi.",
  cwd: process.cwd(),
};

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("normalizeModel", () => {
  test("strips the models/ prefix", () => {
    expect(normalizeModel("models/gemini-2.0-pro")).toBe("gemini-2.0-pro");
  });

  test("passes bare gemini names through", () => {
    expect(normalizeModel("gemini-1.5-flash")).toBe("gemini-1.5-flash");
  });

  test("falls back to the default for empty or non-gemini names", () => {
    expect(normalizeModel(undefined)).toBe("gemini-2.0-flash");
    expect(normalizeModel("gpt-4o")).toBe("gemini-2.0-flash");
  });
});

describe("GeminiProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("throws when no API key is configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    expect(() => new GeminiProvider()).toThrow(/GEMINI_API_KEY/);
  });

  test("returns text and usage from a successful response", async () => {
    mockFetch(200, {
      candidates: [{ content: { parts: [{ text: "Hi" }, { text: " there" }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
    });

    const result = await new GeminiProvider("test-key").run(REQUEST);
    expect(result.text).toBe("Hi there");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  });

  test("sends the key as a header, never in the URL", async () => {
    const fetchMock = mockFetch(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await new GeminiProvider("secret-key").run(REQUEST);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain("secret-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
  });

  test("attaches images as inlineData parts", async () => {
    const fetchMock = mockFetch(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await new GeminiProvider("k").run({
      ...REQUEST,
      images: [{ base64: "AAAA", mimeType: "image/png" }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents[0].parts).toContainEqual({
      inlineData: { mimeType: "image/png", data: "AAAA" },
    });
    expect(body.systemInstruction.parts[0].text).toBe("You are terse.");
  });

  test("surfaces the API error message on a failed request", async () => {
    mockFetch(429, { error: { message: "Quota exceeded" } });
    await expect(new GeminiProvider("k").run(REQUEST)).rejects.toThrow(/Quota exceeded/);
  });

  test("raises safety blocks instead of returning an empty answer", async () => {
    // Gemini returns 200 with no candidates when it blocks — an empty string
    // here would read as a successful but empty response.
    mockFetch(200, { promptFeedback: { blockReason: "SAFETY" }, candidates: [] });
    await expect(new GeminiProvider("k").run(REQUEST)).rejects.toThrow(/blocked.*SAFETY/i);
  });
});
