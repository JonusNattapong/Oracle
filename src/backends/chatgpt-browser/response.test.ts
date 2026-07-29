import { describe, expect, test, vi } from "vitest";
import {
  normalizeChatGptConversationUrl,
  ResponseMonitor,
  type CdpClient,
  type ResponseBaseline
} from "./response.js";

function fakeClient(values: unknown[]): CdpClient {
  return {
    send: vi.fn(async () => ({})),
    evaluate: vi.fn(async () => values.shift()) as CdpClient["evaluate"],
    evaluateAsync: vi.fn(async () => values.shift()) as CdpClient["evaluateAsync"]
  };
}

describe("ResponseMonitor", () => {
  test("accepts only canonical ChatGPT conversation URLs", () => {
    expect(
      normalizeChatGptConversationUrl("https://chatgpt.com/c/abc-123?temporary-chat=true#top")
    ).toBe("https://chatgpt.com/c/abc-123");
    expect(
      normalizeChatGptConversationUrl("https://chat.openai.com/c/abc-123")
    ).toBe("https://chatgpt.com/c/abc-123");
    expect(normalizeChatGptConversationUrl("https://example.com/c/abc-123")).toBeUndefined();
    expect(normalizeChatGptConversationUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeChatGptConversationUrl("https://chatgpt.com/g/gpt-id")).toBeUndefined();
  });

  test("distinguishes an authenticated account from guest mode without reading cookie values", async () => {
    const authenticated = fakeClient([]);
    authenticated.send = vi.fn(async () => ({
      cookies: [{ name: "__Secure-next-auth.session-token" }]
    }));
    const guest = fakeClient([{
      hasAccountControl: true,
      hasLoginControl: true
    }]);
    guest.send = vi.fn(async () => ({
      cookies: [
        { name: "__Host-next-auth.csrf-token" },
        { name: "__Secure-next-auth.state" }
      ]
    }));

    await expect(
      new ResponseMonitor(authenticated).authenticationStatus()
    ).resolves.toMatchObject({ authenticated: true });
    await expect(
      new ResponseMonitor(guest).authenticationStatus()
    ).resolves.toMatchObject({ authenticated: false });
  });

  test("waits for a new response instead of returning a stable previous answer", async () => {
    const client = fakeClient([
      { isStreaming: false, count: 1, text: "old answer" },
      { isStreaming: true, count: 2, text: "new" },
      { isStreaming: false, count: 2, text: "new answer" },
      { isStreaming: false, count: 2, text: "new answer" },
      {
        isStreaming: false,
        hasCompletionAction: true,
        count: 2,
        text: "new answer"
      }
    ]);
    const monitor = new ResponseMonitor(client);
    const baseline: ResponseBaseline = { count: 1, lastText: "old answer" };

    await expect(monitor.waitForResponse(baseline, 10_000)).resolves.toBe("new answer");
  }, 10_000);

  test("does not return a partial response during a quiet streaming pause", async () => {
    const client = fakeClient([
      { isStreaming: false, count: 2, text: "OME" },
      { isStreaming: false, count: 2, text: "OME" },
      { isStreaming: false, count: 2, text: "OME" },
      { isStreaming: false, count: 2, text: "OMEGA-7319" },
      {
        isStreaming: false,
        hasCompletionAction: true,
        count: 2,
        text: "OMEGA-7319"
      }
    ]);
    const monitor = new ResponseMonitor(client);

    await expect(
      monitor.waitForResponse({ count: 1, lastText: "TURN1_OK" }, 10_000)
    ).resolves.toBe("OMEGA-7319");
  }, 10_000);

  test("completes an image-only assistant turn without requiring markdown text", async () => {
    const client = fakeClient([{
      isStreaming: false,
      hasCompletionAction: true,
      count: 0,
      assistantTurnCount: 1,
      assistantImageCount: 1,
      text: ""
    }]);
    const monitor = new ResponseMonitor(client);

    await expect(monitor.waitForResponse({
      count: 0,
      lastText: "",
      assistantTurnCount: 0,
      assistantImageCount: 0
    }, 2_000)).resolves.toBe("[ChatGPT returned 1 image(s)]");
  });

  test("reloads once to recover a stalled response and returns only the finalized text", async () => {
    vi.useFakeTimers();
    try {
      const partial = {
        isStreaming: false,
        count: 2,
        text: "Z",
        hasCompletionAction: false
      };
      const client = fakeClient([
        ...Array.from({ length: 31 }, () => partial),
        {
          isStreaming: false,
          count: 2,
          text: "ZETA7319",
          hasCompletionAction: true
        }
      ]);
      const monitor = new ResponseMonitor(client);
      const result = monitor.waitForResponse(
        { count: 1, lastText: "ACK1" },
        60_000
      );

      await vi.advanceTimersByTimeAsync(35_000);

      await expect(result).resolves.toBe("ZETA7319");
      expect(client.send).toHaveBeenCalledWith(
        "Page.reload",
        { ignoreCache: false }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports login/setup guidance when the prompt input never appears", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient([
        { ready: false, url: "https://chatgpt.com" },
        { ready: false, url: "https://chatgpt.com" },
        { ready: false, url: "https://chatgpt.com" }
      ]);
      const monitor = new ResponseMonitor(client);
      const promise = monitor.navigateToChatGPT(1_000);
      const assertion = expect(promise).rejects.toThrow(/login/i);
      await vi.advanceTimersByTimeAsync(1_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("can wait on an already-open conversation without reloading it", async () => {
    const client = fakeClient([{
      ready: true,
      url: "https://chatgpt.com/c/already-open"
    }]);
    const monitor = new ResponseMonitor(client);

    await monitor.navigateToChatGPT(
      "https://chatgpt.com/c/already-open",
      1_000,
      false
    );

    expect(client.send).not.toHaveBeenCalledWith(
      "Page.navigate",
      expect.anything()
    );
  });

  test("waits for the new-chat root instead of accepting the previous conversation", async () => {
    const client = fakeClient([
      { ready: true, url: "https://chatgpt.com/c/previous-chat" },
      { ready: true, url: "https://chatgpt.com/" }
    ]);
    const monitor = new ResponseMonitor(client);

    await monitor.navigateToChatGPT("https://chatgpt.com", 2_000);

    expect(client.evaluate).toHaveBeenCalledTimes(2);
  });

  test("attaches images and waits for the composer preview to finish", async () => {
    const client = fakeClient([
      true,
      { success: true, baselineCount: 0 },
      { count: 1, busy: false, matchedNames: 0 }
    ]);
    const monitor = new ResponseMonitor(client);

    await monitor.uploadImages([{
      base64: "iVBORw0KGgoAAAAA",
      mimeType: "image/png",
      fileName: "diagram.png"
    }], 2_000);

    expect(client.evaluate).toHaveBeenCalledTimes(3);
    expect(String(vi.mocked(client.evaluate).mock.calls[1][0])).toContain("DataTransfer");
  });

  test("captures assistant image payloads through an awaited in-browser fetch", async () => {
    const client = fakeClient([{
      images: [{
        base64: "iVBORw0KGgoAAAAA",
        mimeType: "image/png",
        fileName: "generated-1",
        alt: "Generated diagram"
      }],
      warnings: []
    }]);
    const monitor = new ResponseMonitor(client);

    await expect(monitor.captureAssistantImages()).resolves.toMatchObject({
      images: [expect.objectContaining({ alt: "Generated diagram" })]
    });
    expect(client.evaluateAsync).toHaveBeenCalledOnce();
  });
});
