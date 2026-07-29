import type { Provider, ProviderRequest } from "./provider.js";
import type { ProviderResponse } from "../types.js";
import type { DoctorCheck, ExecutionBackendCapabilities } from "../backends/backend.js";

/**
 * Google Gemini provider over the REST API.
 *
 * Uses fetch directly rather than @google/generative-ai so Gemini support adds
 * no dependency — the generateContent surface we need is a single POST.
 */

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.0-flash";
const REQUEST_TIMEOUT_MS = 120_000;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export class GeminiProvider implements Provider {
  readonly id = "gemini";
  readonly capabilities: ExecutionBackendCapabilities = Object.freeze({
    consult: true,
    toolUse: false,
    images: true,
    continuation: false,
    structuredUsage: true,
    supportedPlatforms: Object.freeze(["darwin" as NodeJS.Platform, "linux" as NodeJS.Platform, "win32" as NodeJS.Platform])
  });
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set.");
    this.apiKey = key;
    this.baseUrl = baseUrl ?? process.env.GEMINI_API_BASE ?? DEFAULT_BASE;
  }

  async healthCheck(): Promise<DoctorCheck[]> {
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

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    const model = normalizeModel(request.model);
    const parts: GeminiPart[] = [{ text: request.userPrompt }];
    for (const image of request.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
    }

    const body = {
      contents: [{ role: "user", parts }],
      systemInstruction: request.systemPrompt
        ? { parts: [{ text: request.systemPrompt }] }
        : undefined,
    };

    const url = `${this.baseUrl}/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header auth keeps the key out of URLs, which land in proxy/server logs.
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const payload = (await response.json().catch(() => ({}))) as GeminiResponseBody;

    if (!response.ok) {
      const detail = payload.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`Gemini request failed: ${detail}`);
    }

    // A safety block returns 200 with no candidates — surface it instead of
    // handing back an empty string that reads like a successful empty answer.
    const blockReason = payload.promptFeedback?.blockReason;
    if (blockReason && !payload.candidates?.length) {
      throw new Error(`Gemini blocked the request: ${blockReason}`);
    }

    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    return {
      text,
      usage: {
        inputTokens: payload.usageMetadata?.promptTokenCount,
        outputTokens: payload.usageMetadata?.candidatesTokenCount,
        totalTokens: payload.usageMetadata?.totalTokenCount,
      },
    };
  }
}

/**
 * Accept both `gemini-2.0-flash` and the fully qualified `models/gemini-2.0-flash`,
 * and fall back to a default when a non-Gemini model name is routed here.
 */
export function normalizeModel(model: string | undefined): string {
  if (!model) return DEFAULT_MODEL;
  const trimmed = model.startsWith("models/") ? model.slice("models/".length) : model;
  return trimmed.toLowerCase().startsWith("gemini") ? trimmed : DEFAULT_MODEL;
}

/** Models this provider serves, for `oracle models list`. */
export const GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-pro",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
] as const;
