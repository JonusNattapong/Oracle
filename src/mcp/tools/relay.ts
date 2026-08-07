import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MemoryType } from "../../memory/adapter.js";
import { runConsultPipeline, type PipelineDeps, type PipelineContext, type ConsultHooks } from "../pipeline/consultPipeline.js";
import {
  SoulSchema,
  FilesSchema,
  IncludeDocsSchema,
  GitDiffSchema,
  GitStagedSchema,
  AstResolveSchema,
  WebSearchSchema,
  DeepResearchSchema,
} from "../pipeline/schema.js";

const MEMORY_TYPE = z.enum(["fact", "insight", "chunk", "working"]);

/**
 * oracle_relay — the middleman / memory-bank hub.
 *
 * Oracle already stores memories and already mediates between callers and AI
 * backends, but those two roles live in separate tools. `oracle_relay` fuses
 * them into one explicit middleware layer: it accepts a request, archives the
 * question into working memory, enriches it with recalled facts, consults the
 * configured AI backend, then files the Q&A back into the memory bank so a
 * later search for the same topic finds the answer without asking again.
 *
 * Every interaction is tagged `relay` so past exchanges are discoverable
 * with `oracle_memory_search { query, tags: ["relay"] }`.
 */
export function registerRelayTool(server: McpServer, deps: PipelineDeps): void {
  server.registerTool(
    "oracle_relay",
    {
      title: "Relay via Oracle",
      description:
        "Act as a middleman: store your request in working memory, enrich it with recalled project memory, "
        + "consult the AI backend, then archive the Q&A as a durable fact/insight so the same question "
        + "is answered from memory on future calls. Pass `files` to include code, `conversation_id` for "
        + "multi-turn continuity, and `store_as` to control how the answer is filed (default: insight).",
      inputSchema: {
        prompt: z.string().min(1).describe("The question or task you want Oracle to relay to the AI backend"),
        agent: z.string().optional().describe("Attribution for memory — who is asking (e.g. 'codex-main')"),
        store_as: MEMORY_TYPE.optional().default("insight").describe("How to file the answer in memory: fact (short, durable truth), insight (analysis), chunk (verbatim), working (transient)"),
        tags: z.array(z.string().min(1)).max(50).optional().describe("Tags to attach to the stored memory entries"),
        recall: z.boolean().optional().default(true).describe("Whether to recall relevant stored memory before answering"),
        files: FilesSchema,
        conversation_id: z
          .string()
          .optional()
          .describe("Stable id for this exchange — pass across calls for multi-turn recall"),
        soul: SoulSchema,
        include_docs: IncludeDocsSchema,
        git_diff: GitDiffSchema,
        git_staged: GitStagedSchema,
        ast_resolve: AstResolveSchema,
        web_search: WebSearchSchema,
        deep_research: DeepResearchSchema,
      },
    },
    async ({
      prompt,
      agent = "oracle",
      store_as,
      tags = [],
      recall,
      files,
      conversation_id,
      soul,
      include_docs,
      git_diff,
      git_staged,
      ast_resolve,
      web_search,
      deep_research,
    }) => {
      const allTags = ["relay", ...tags];

      const hooks: ConsultHooks = {
        async onBeforeExecute(ctx: PipelineContext) {
          const requestEntry = await deps.memory.remember(agent, "working", prompt, {
            tags: [...allTags, "request"],
            importance: 0.7,
          });
          ctx.state.requestEntry = requestEntry;
        },

        async onAfterExecute(
          ctx: PipelineContext,
          result
        ): Promise<Record<string, unknown>> {
          const qaContent = `**Q:** ${prompt}\n\n**A:** ${result.output}`;
          const storedEntry = await deps.memory.remember(
            agent,
            store_as as MemoryType,
            qaContent,
            {
              tags: allTags,
              importance: store_as === "fact" ? 0.9 : 0.8,
              meta: {
                source: "relay",
                sessionId: result.sessionId,
                responseId: result.responseId,
              },
            }
          );

          return {
            memory: {
              workingEntryId: (ctx.state.requestEntry as { id: string } | undefined)?.id,
              storedEntryId: storedEntry.id,
              storedType: store_as,
              storedTags: allTags,
            },
          };
        },
      };

      return runConsultPipeline(
        {
          prompt,
          preset: "relay",
          agent,
          files,
          gitDiff: git_diff,
          gitStaged: git_staged,
          astResolve: ast_resolve,
          includeDocs: include_docs,
          includeMemory: recall,
          conversationId: conversation_id,
          soul,
          webSearch: web_search,
          deepResearch: deep_research,
        },
        deps,
        hooks
      );
    }
  );
}
