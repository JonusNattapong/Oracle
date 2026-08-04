import { describe, expect, test, vi } from "vitest";
import { SseFrameParser, ChatGptStreamReader } from "./stream.js";
import type { CdpEvent, CdpEventClient } from "./response.js";

function client(): CdpEventClient & { listeners: Set<(event: CdpEvent) => void> } {
  const listeners = new Set<(event: CdpEvent) => void>();
  return {
    listeners,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send<T>(method: string): Promise<T> {
      if (method === "Network.streamResourceContent") return { bufferedData: "" } as T;
      return {} as T;
    },
    async evaluate<T>(): Promise<T> { throw new Error("unused"); },
    async evaluateAsync<T>(): Promise<T> { throw new Error("unused"); }
  };
}

describe("SseFrameParser", () => {
  test("parses split full-message frames and usage", () => {
    const parser = new SseFrameParser();
    const frame = 'data: {"message":{"content":{"parts":["Hello"]}}}\n\n';
    expect(parser.push(frame.slice(0, 18))).toEqual([]);
    expect(parser.push(frame.slice(18))).toEqual(["Hello"]);
    expect(parser.result()).toMatchObject({ text: "Hello" });
  });

  test("accepts patch deltas and ignores empty/done frames", () => {
    const parser = new SseFrameParser();
    expect(parser.push("data: {\"p\":\"/message/content/parts/0\",\"v\":\"Hi\"}\n\n")).toEqual(["Hi"]);
    expect(parser.push("data: [DONE]\n\n")).toEqual([]);
    expect(parser.result().text).toBe("Hi");
  });

  test("ignores malformed frames and empty streams", () => {
    const parser = new SseFrameParser();
    expect(parser.push("data: nope\n\n")).toEqual([]);
    expect(parser.finish()).toEqual([]);
    expect(parser.result().text).toBe("");
  });
});

describe("ChatGptStreamReader", () => {
  test("cleans listeners on success", async () => {
    const c = client();
    const reader = new ChatGptStreamReader(c);
    await reader.start();
    const promise = reader.read();
    for (const listener of c.listeners) listener({ method: "Network.requestWillBeSent", params: { requestId: "1", request: { url: "https://chatgpt.com/backend-api/conversation", method: "POST" } } });
    for (const listener of c.listeners) listener({ method: "Network.responseReceived", params: { requestId: "1" } });
    for (const listener of c.listeners) listener({ method: "Network.dataReceived", params: { requestId: "1", data: 'data: {"message":{"content":{"parts":["ok"]}}}\n\n' } });
    for (const listener of c.listeners) listener({ method: "Network.dataReceived", params: { requestId: "1", data: "data: [DONE]\n\n" } });
    for (const listener of c.listeners) listener({ method: "Network.loadingFinished", params: { requestId: "1" } });
    await expect(promise).resolves.toMatchObject({ text: "ok" });
    expect(c.listeners.size).toBe(0);
  });

  test("rejects malformed/no-text stream and cleans listeners", async () => {
    const c = client();
    const reader = new ChatGptStreamReader(c);
    await reader.start();
    const promise = reader.read();
    for (const listener of c.listeners) listener({ method: "Network.requestWillBeSent", params: { requestId: "1", request: { url: "https://chatgpt.com/backend-api/conversation", method: "POST" } } });
    for (const listener of c.listeners) listener({ method: "Network.responseReceived", params: { requestId: "1" } });
    for (const listener of c.listeners) listener({ method: "Network.dataReceived", params: { requestId: "1", data: "data: [DONE]\n\n" } });
    for (const listener of c.listeners) listener({ method: "Network.loadingFinished", params: { requestId: "1" } });
    await expect(promise).rejects.toThrow("no text");
    expect(c.listeners.size).toBe(0);
  });

  test("exposes delta callback", async () => {
    const c = client();
    const onDelta = vi.fn();
    const reader = new ChatGptStreamReader(c, { onDelta });
    await reader.start();
    const promise = reader.read();
    for (const listener of c.listeners) listener({ method: "Network.requestWillBeSent", params: { requestId: "1", request: { url: "https://chatgpt.com/backend-api/conversation", method: "POST" } } });
    for (const listener of c.listeners) listener({ method: "Network.responseReceived", params: { requestId: "1" } });
    for (const listener of c.listeners) listener({ method: "Network.dataReceived", params: { requestId: "1", data: 'data: {"message":{"content":{"parts":["ok"]}}}\n\n' } });
    for (const listener of c.listeners) listener({ method: "Network.dataReceived", params: { requestId: "1", data: "data: [DONE]\n\n" } });
    for (const listener of c.listeners) listener({ method: "Network.loadingFinished", params: { requestId: "1" } });
    await promise;
    expect(onDelta).toHaveBeenCalledWith("ok");
  });
});
