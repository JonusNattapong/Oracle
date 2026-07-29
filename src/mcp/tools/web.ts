import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serializeOracleError } from "../../errors.js";
import { webSearchWithTrace } from "../../web/search.js";
import { fetchUrl } from "../../web/fetchUrl.js";
import { agentqlExtract } from "../../web/providers/agentql.js";
import { SEARCH_PROVIDERS, FETCH_PROVIDERS } from "../../web/types.js";

function success(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>
  };
}

export function registerWebTools(server: McpServer): void {
  server.registerTool(
    "oracle_web_search",
    {
      title: "Web Search",
      description: "Web search via Brave, Tavily, or Firecrawl.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
        provider: z.enum(SEARCH_PROVIDERS as [string, ...string[]]).optional()
      }
    },
    async ({ query, limit, provider }) => {
      try {
        const outcome = await webSearchWithTrace(query, limit, provider as any);
        return success(JSON.stringify(outcome.results, null, 2), {
          count: outcome.results.length,
          results: outcome.results,
          provider: outcome.provider,
          attempts: outcome.attempts
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_web_fetch",
    {
      title: "Fetch URL",
      description: "Fetch URL as readable text. 'native' (SSRF-guarded) strips HTML; 'firecrawl' uses JS rendering.",
      inputSchema: {
        url: z.string().min(1),
        provider: z.enum(FETCH_PROVIDERS as [string, ...string[]]).default("native")
      }
    },
    async ({ url, provider }) => {
      try {
        const page = await fetchUrl(url, provider as any);
        return success(page.text, { url: page.url, title: page.title, length: page.text.length });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_web_extract",
    {
      title: "Extract Structured Data",
      description: "Extract structured data from a URL via AgentQL. Requires AGENTQL_API_KEY.",
      inputSchema: {
        url: z.string().min(1),
        prompt: z.string().min(1).describe("What to extract, e.g. 'the product name, price, and in-stock status'")
      }
    },
    async ({ url, prompt }) => {
      try {
        const result = await agentqlExtract(url, prompt);
        return success(JSON.stringify(result.data, null, 2), { data: result.data, sourceUrl: result.sourceUrl });
      } catch (error) { return failure(error); }
    }
  );
}
