import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderRequest } from "./provider.js";
import type { ProviderResponse } from "../types.js";
import { AnthropicOAuthClient, type PlanTier } from "../auth/anthropic-oauth.js";
import type { AgentMessage, AgentProvider, AgentTool, AgentTurn, ToolCall, ContentBlock } from "../agent/types.js";
import type { DoctorCheck, ExecutionBackendCapabilities } from "../backends/backend.js";

const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** Auto-selected model per subscription tier when the caller passes "auto" as the model. */
const TIER_MODEL: Record<PlanTier, string> = {
  api: "claude-sonnet-5",
  pro: "claude-sonnet-5",
  max: "claude-opus-4-8"
};

/** Conservative SDK retry ceilings per tier — paid subscription tiers carry higher throughput limits. */
const TIER_MAX_RETRIES: Record<PlanTier, number> = {
  api: 2,
  pro: 3,
  max: 5
};

/** Convert neutral ContentBlock[] to Anthropic format. */
function toAnthropicContentBlocks(blocks: ContentBlock[]): Anthropic.ContentBlockParam[] {
  return blocks.flatMap((block): Anthropic.ContentBlockParam[] => {
    if (block.type === "text") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "image") {
      return [{
        type: "image",
        source: {
          type: "base64" as const,
          media_type: block.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: block.data
        }
      }];
    }
    if (block.type === "video") {
      return [{
        type: "video" as any,
        source: {
          type: "base64" as const,
          media_type: block.mimeType as any,
          data: block.data
        }
      }];
    }
    return [];
  });
}

/** Translate the neutral transcript into Anthropic message params. */
function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") {
      const content = typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content }]
        : toAnthropicContentBlocks(m.content);
      return { role: "user", content };
    }
    if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const call of m.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      return { role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] };
    }
    // tool results are sent back as a user message of tool_result blocks
    return {
      role: "user",
      content: m.results.map((r) => {
        const contentBlocks = toAnthropicContentBlocks(r.content);
        return {
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: contentBlocks.length === 1 && contentBlocks[0]?.type === "text"
            ? (contentBlocks[0] as Anthropic.TextBlockParam).text
            : (contentBlocks as any),
          is_error: r.isError,
        };
      }),
    };
  });
}

const ANTHROPIC_CAPABILITIES: ExecutionBackendCapabilities = {
  consult: true,
  toolUse: true,
  images: true,
  continuation: false,
  structuredUsage: true,
  supportedPlatforms: ["darwin", "linux", "win32"]
};

export class AnthropicProvider implements Provider, AgentProvider {
  readonly id = "anthropic";
  readonly capabilities = ANTHROPIC_CAPABILITIES;
  private client?: Anthropic;
  private planTier: PlanTier = "api";
  private readonly oauth: AnthropicOAuthClient | null;
  private readonly apiKey?: string;

  constructor(
    apiKey = process.env.ANTHROPIC_API_KEY,
    oauth?: AnthropicOAuthClient
  ) {
    this.oauth = oauth ?? null;
    this.apiKey = apiKey;
  }

  async healthCheck(): Promise<DoctorCheck[]> {
    if (this.apiKey) {
      return [{ name: "anthropic credentials", ok: true, detail: "ANTHROPIC_API_KEY set" }];
    }
    const entry = this.oauth ? await this.oauth.readSessionEntry() : null;
    if (!entry) {
      return [{
        name: "anthropic credentials",
        ok: false,
        detail: "no ANTHROPIC_API_KEY and no OAuth session — run `oracle login --provider anthropic`"
      }];
    }
    const expired = Boolean(entry.expiresAt && Date.now() >= entry.expiresAt);
    const usable = !expired || Boolean(entry.refreshToken);
    const detail = !expired
      ? `OAuth session (plan: ${entry.planTier ?? "api"})`
      : entry.refreshToken
        ? "OAuth session expired, refreshes on next use"
        : "OAuth session expired — run `oracle login --provider anthropic`";
    return [{ name: "anthropic credentials", ok: usable, detail }];
  }

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;

    if (this.apiKey) {
      // Direct API key — no subscription tier to route on.
      this.planTier = "api";
      this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: TIER_MAX_RETRIES.api });
      return this.client;
    }

    if (!this.oauth) throw new Error(
      "ANTHROPIC_API_KEY is not set. Run `oracle login --provider anthropic` or set the environment variable."
    );
    const token = await this.oauth.getValidToken();
    if (!token) throw new Error("No Anthropic OAuth session found. Run `oracle login --provider anthropic` first.");

    this.planTier = await this.oauth.getPlanTier();
    // OAuth tokens authenticate via `Authorization: Bearer`, not `x-api-key` — use authToken,
    // not apiKey, and send the oauth beta header the API requires for bearer-token requests.
    this.client = new Anthropic({
      authToken: token,
      maxRetries: TIER_MAX_RETRIES[this.planTier],
      defaultHeaders: { "anthropic-beta": OAUTH_BETA_HEADER }
    });
    return this.client;
  }

  /** Resolves "auto" to the best model for the caller's subscription tier; explicit models pass through unchanged. */
  private resolveModel(requestedModel: string): string {
    if (requestedModel === "auto") return TIER_MODEL[this.planTier];
    return requestedModel;
  }

  /** Pro/Max subscriptions can use the Batch API for non-latency-sensitive work at reduced cost. */
  supportsBatch(): boolean {
    return this.planTier === "pro" || this.planTier === "max";
  }

  private buildContent(request: ProviderRequest): Anthropic.MessageParam["content"] {
    const content: Anthropic.MessageParam["content"] = [{ type: "text", text: request.userPrompt }];
    if (request.images?.length) {
      content.push(
        ...request.images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: img.base64
          }
        }))
      );
    }
    return content;
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    const client = await this.getClient();

    const msg = await client.messages.create({
      model: this.resolveModel(request.model),
      max_tokens: 8192,
      system: request.systemPrompt,
      messages: [{ role: "user", content: this.buildContent(request) }]
    });

    return {
      text: msg.content.map((b: Anthropic.ContentBlock) => (b.type === "text" ? b.text : "")).join(""),
      usage: {
        inputTokens: msg.usage?.input_tokens,
        outputTokens: msg.usage?.output_tokens,
        totalTokens:
          msg.usage?.input_tokens != null && msg.usage?.output_tokens != null
            ? msg.usage.input_tokens + msg.usage.output_tokens
            : undefined
      }
    };
  }

  /**
   * Runs one agentic turn with tools available: sends the current transcript
   * plus tool schemas, and returns the assistant's text + any tool_use blocks
   * as a neutral AgentTurn for the provider-agnostic loop to act on.
   */
  async runAgentTurn(params: {
    model: string;
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<AgentTurn> {
    const client = await this.getClient();
    const msg = await client.messages.create({
      model: this.resolveModel(params.model),
      max_tokens: 8192,
      system: params.system,
      messages: toAnthropicMessages(params.messages),
      tools: params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    });

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of msg.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      message: { role: "assistant", text, toolCalls },
      usage: { inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens },
    };
  }

  /**
   * Submits a batch of requests via the Message Batches API (50% cost reduction, async).
   * Only available to Pro/Max sessions — callers should check `supportsBatch()` first.
   */
  async runBatch(requests: ProviderRequest[]): Promise<Map<string, ProviderResponse>> {
    const client = await this.getClient();
    if (!this.supportsBatch()) {
      throw new Error("Batch API requires a Pro or Max Anthropic subscription.");
    }

    const batch = await client.messages.batches.create({
      requests: requests.map((request, index) => ({
        custom_id: `req-${index}`,
        params: {
          model: this.resolveModel(request.model),
          max_tokens: 8192,
          system: request.systemPrompt,
          messages: [{ role: "user" as const, content: this.buildContent(request) }]
        }
      }))
    });

    let status = batch;
    const maxPolls = 120; // 120 * 5s = 10 minutes max
    for (let poll = 0; poll < maxPolls; poll++) {
      if (status.processing_status === "ended") break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      status = await client.messages.batches.retrieve(batch.id);
    }
    if (status.processing_status !== "ended") {
      throw new Error(`Batch ${batch.id} did not complete within the polling timeout.`);
    }

    const results = new Map<string, ProviderResponse>();
    for await (const result of await client.messages.batches.results(batch.id)) {
      if (result.result.type === "succeeded") {
        const msg = result.result.message;
        results.set(result.custom_id, {
          text: msg.content.map((b: Anthropic.ContentBlock) => (b.type === "text" ? b.text : "")).join(""),
          usage: {
            inputTokens: msg.usage?.input_tokens,
            outputTokens: msg.usage?.output_tokens,
            totalTokens:
              msg.usage?.input_tokens != null && msg.usage?.output_tokens != null
                ? msg.usage.input_tokens + msg.usage.output_tokens
                : undefined
          }
        });
      }
    }
    return results;
  }
}
