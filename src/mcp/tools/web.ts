import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { success, failure } from "../response.js";
import { webSearchWithTrace } from "../../web/search.js";
import { fetchUrl } from "../../web/fetchUrl.js";
import { agentqlExtract } from "../../web/providers/agentql.js";
import { SEARCH_PROVIDERS, FETCH_PROVIDERS } from "../../web/types.js";

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
      description:
        "Read a URL. By default returns readable text — 'native' (SSRF-guarded) strips HTML, "
        + "'firecrawl' renders JS. Pass `extract` to describe what you want instead and get "
        + "structured data back via AgentQL (requires AGENTQL_API_KEY); `provider` does not "
        + "apply in that case, because AgentQL does its own retrieval.",
      inputSchema: {
        url: z.string().min(1),
        provider: z.enum(FETCH_PROVIDERS as [string, ...string[]]).default("native"),
        extract: z.string().min(1).optional()
          .describe("What to extract, e.g. 'the product name, price, and in-stock status'")
      }
    },
    async ({ url, provider, extract }) => {
      try {
        if (extract) {
          const result = await agentqlExtract(url, extract);
          return success(JSON.stringify(result.data, null, 2), {
            mode: "extract", data: result.data, sourceUrl: result.sourceUrl
          });
        }
        const page = await fetchUrl(url, provider as any);
        return success(page.text, {
          mode: "text", url: page.url, title: page.title, length: page.text.length
        });
      } catch (error) { return failure(error); }
    }
  );
}
