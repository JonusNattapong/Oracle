import type { CdpEvent, CdpEventClient } from "./response.js";

export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatGptStreamResult {
  text: string;
  usage?: StreamUsage;
  modelSlug?: string;
}

interface StreamState {
  text: string;
  usage?: StreamUsage;
  modelSlug?: string;
  done: boolean;
}

const CONVERSATION_PATH = "/backend-api/conversation";

/**
 * `/backend-api/conversation` is a prefix of several other endpoints — `/conversation/{id}`
 * for history, `/conversations` for the sidebar — and those fire first. Latching onto one
 * of them pins the reader to a request that has already finished, so the POST carrying the
 * answer is never read. Only the exact path, and only the POST, is the turn.
 */
function isConversationTurn(url: string, method: string | undefined): boolean {
  if (method !== undefined && method.toUpperCase() !== "POST") return false;
  try {
    return new URL(url).pathname === CONVERSATION_PATH;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsage(value: unknown): StreamUsage | undefined {
  if (!isRecord(value)) return undefined;
  const promptTokens = numberAt(value.prompt_tokens ?? value.promptTokens);
  const completionTokens = numberAt(value.completion_tokens ?? value.completionTokens);
  return promptTokens !== undefined && completionTokens !== undefined
    ? { promptTokens, completionTokens }
    : undefined;
}

function readText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const message = isRecord(value.message) ? value.message : undefined;
  const content = message && isRecord(message.content) ? message.content : undefined;
  const parts = content?.parts;
  return Array.isArray(parts) && typeof parts[0] === "string" ? parts[0] : undefined;
}

function longestCommonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

export class SseFrameParser {
  private buffer = "";
  private state: StreamState = { text: "", done: false };

  push(chunk: string): string[] {
    this.buffer += chunk.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const frames: string[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      frames.push(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames.flatMap((frame) => this.consumeFrame(frame));
  }

  finish(): string[] {
    if (!this.buffer.trim()) return [];
    const frame = this.buffer;
    this.buffer = "";
    return this.consumeFrame(frame);
  }

  result(): StreamState {
    return this.state;
  }

  private consumeFrame(frame: string): string[] {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return [];
    if (data === "[DONE]") {
      this.state.done = true;
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return [];
    }
    if (!isRecord(parsed)) return [];

    const messageText = readText(parsed);
    if (messageText !== undefined) {
      const previous = this.state.text;
      const prefix = longestCommonPrefixLength(previous, messageText);
      this.state.text = messageText;
      const delta = messageText.slice(prefix);
      if (delta) return [delta];
    }

    const value = parsed.v;
    if (typeof value === "string" && typeof parsed.p === "string" && parsed.p.includes("parts")) {
      this.state.text += value;
      return [value];
    }

    const usage = readUsage(parsed.usage)
      ?? (isRecord(parsed.message) ? readUsage(parsed.message.usage) : undefined)
      ?? (isRecord(parsed.message) && isRecord(parsed.message.metadata)
        ? readUsage(parsed.message.metadata.token_usage)
        : undefined);
    if (usage) this.state.usage = usage;
    const modelSlug = typeof parsed.model_slug === "string"
      ? parsed.model_slug
      : isRecord(parsed.message) && isRecord(parsed.message.metadata)
        && typeof parsed.message.metadata.model_slug === "string"
        ? parsed.message.metadata.model_slug
        : undefined;
    if (modelSlug) this.state.modelSlug = modelSlug;
    return [];
  }
}

export interface ChatGptStreamReaderOptions {
  onDelta?: (chunk: string) => void;
}

export class ChatGptStreamReader {
  private unsubscribe?: () => void;
  private requestId?: string;
  private readonly parser = new SseFrameParser();
  private readonly completion: Promise<ChatGptStreamResult>;
  private resolveCompletion: ((result: ChatGptStreamResult) => void) | undefined;
  private rejectCompletion: ((error: Error) => void) | undefined;
  private started = false;
  private settled = false;
  private readonly turnRequestIds = new Set<string>();

  constructor(
    private readonly client: CdpEventClient,
    private readonly options: ChatGptStreamReaderOptions = {}
  ) {
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = (result) => {
        if (this.settled) return;
        this.settled = true;
        resolve(result);
      };
      this.rejectCompletion = (error) => {
        if (this.settled) return;
        this.settled = true;
        reject(error);
      };
    });
  }

  cancel(): void {
    this.rejectCompletion?.(new Error("ChatGPT stream cancelled."));
    void this.cleanup();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.client.onEvent((event) => this.handleEvent(event));
    try {
      await this.client.send("Network.enable");
    } catch (error) {
      await this.cleanup();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async read(): Promise<ChatGptStreamResult> {
    try {
      const result = await this.completion;
      if (!result.text.trim()) throw new Error("ChatGPT stream produced no text.");
      return result;
    } finally {
      await this.cleanup();
    }
  }

  fail(error: Error): void {
    this.rejectCompletion?.(error);
  }

  private handleEvent(event: CdpEvent): void {
    if (event.method === "Network.requestWillBeSent") {
      const request = isRecord(event.params.request) ? event.params.request : undefined;
      const url = request && typeof request.url === "string" ? request.url : "";
      const method = request && typeof request.method === "string" ? request.method : undefined;
      const requestId = typeof event.params.requestId === "string" ? event.params.requestId : undefined;
      if (requestId && isConversationTurn(url, method)) this.turnRequestIds.add(requestId);
      return;
    }
    if (event.method === "Network.responseReceived") {
      const requestId = typeof event.params.requestId === "string" ? event.params.requestId : undefined;
      if (requestId && this.turnRequestIds.has(requestId)) {
        this.requestId = requestId;
        void this.enableStreaming(requestId);
      }
      return;
    }
    if (event.method === "Network.dataReceived" && event.params.requestId === this.requestId) {
      const data = typeof event.params.data === "string" ? event.params.data : undefined;
      const base64Encoded = event.params.base64Encoded === true;
      if (data) this.consumeBody(data, base64Encoded);
      return;
    }
    if (event.method === "Network.loadingFinished" && event.params.requestId === this.requestId) {
      void this.finish();
    }
  }

  private async enableStreaming(requestId: string): Promise<void> {
    try {
      const result = await this.client.send<{ bufferedData?: string }>("Network.streamResourceContent", { requestId });
      if (result.bufferedData) this.consumeBody(result.bufferedData, true);
    } catch (error) {
      this.rejectCompletion?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consumeBody(data: string, base64: boolean): void {
    const chunk = base64 ? Buffer.from(data, "base64").toString("utf8") : data;
    for (const delta of this.parser.push(chunk)) this.options.onDelta?.(delta);
  }

  private async finish(): Promise<void> {
    try {
      for (const delta of this.parser.finish()) this.options.onDelta?.(delta);
      const state = this.parser.result();
      this.resolveCompletion?.(state);
    } catch (error) {
      this.rejectCompletion?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async cleanup(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.turnRequestIds.clear();
    if (!this.started) return;
    this.started = false;
    try {
      await this.client.send("Network.disable");
    } catch {
      // The page may already be closing; the reader is still cleaned up.
    }
  }
}

