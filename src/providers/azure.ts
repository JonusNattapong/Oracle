import { AzureOpenAI } from "openai";
import type { ProviderResponse } from "../types.js";
import type { Provider, ProviderRequest } from "./provider.js";

export interface AzureProviderOptions {
  apiKey?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

export class AzureOpenAIProvider implements Provider {
  readonly id = "azure";
  readonly capabilities = {
    consult: true,
    toolUse: false,
    images: false,
    continuation: true,
    structuredUsage: true,
    supportedPlatforms: ["darwin", "linux", "win32"] as const
  };
  private readonly client: AzureOpenAI;

  constructor(options: AzureProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
    const endpoint = options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
    const deployment = options.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION;
    const missing = [
      !apiKey && "AZURE_OPENAI_API_KEY",
      !endpoint && "AZURE_OPENAI_ENDPOINT",
      !deployment && "AZURE_OPENAI_DEPLOYMENT",
      !apiVersion && "AZURE_OPENAI_API_VERSION"
    ].filter(Boolean);
    if (missing.length) throw new Error(`Missing Azure configuration: ${missing.join(", ")}.`);
    this.client = new AzureOpenAI({
      apiKey,
      endpoint,
      deployment,
      apiVersion
    });
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.responses.create({
      model: request.model,
      instructions: request.systemPrompt,
      input: request.userPrompt,
      previous_response_id: request.previousResponseId,
      store: true
    });
    return {
      responseId: response.id,
      text: response.output_text,
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        totalTokens: response.usage?.total_tokens
      }
    };
  }

  async healthCheck() {
    return [{ name: "azure configuration", ok: true, detail: "configured" }];
  }
}
