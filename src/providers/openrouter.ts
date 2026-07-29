import OpenAI from "openai";
import type { ProviderResponse } from "../types.js";
import type { Provider, ProviderRequest } from "./provider.js";

export interface OpenRouterOptions {
  apiKey?: string;
  baseURL?: string;
  siteUrl?: string;
  appName?: string;
}

export class OpenRouterProvider implements Provider {
  readonly id = "openrouter";
  readonly capabilities = {
    consult: true,
    toolUse: false,
    images: true,
    continuation: false,
    structuredUsage: true,
    supportedPlatforms: ["darwin", "linux", "win32"] as const
  };
  private readonly client: OpenAI;

  constructor(options: OpenRouterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
    this.client = new OpenAI({
      apiKey,
      baseURL:
        options.baseURL ??
        process.env.OPENROUTER_BASE_URL ??
        "https://openrouter.ai/api/v1",
      defaultHeaders: {
        ...(options.siteUrl ?? process.env.OPENROUTER_SITE_URL
          ? { "HTTP-Referer": options.siteUrl ?? process.env.OPENROUTER_SITE_URL }
          : {}),
        ...(options.appName ?? process.env.OPENROUTER_APP_NAME
          ? { "X-OpenRouter-Title": options.appName ?? process.env.OPENROUTER_APP_NAME }
          : {})
      }
    });
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.previousResponseId) {
      throw new Error("OpenRouter chat completions do not support stored response follow-up ids.");
    }
    const userContent: OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] =
      request.images?.length
        ? [
            { type: "text", text: request.userPrompt },
            ...request.images.map((image) => ({
              type: "image_url" as const,
              image_url: {
                url: `data:${image.mimeType};base64,${image.base64}`,
                detail: "auto" as const
              }
            }))
          ]
        : request.userPrompt;
    const response = await this.client.chat.completions.create({
      model: request.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: userContent }
      ]
    });
    const text = response.choices
      .map((choice) =>
        typeof choice.message.content === "string" ? choice.message.content : ""
      )
      .join("\n")
      .trim();
    return {
      responseId: response.id,
      text,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens
      }
    };
  }

  async healthCheck() {
    return [{ name: "openrouter configuration", ok: true, detail: "configured" }];
  }
}
