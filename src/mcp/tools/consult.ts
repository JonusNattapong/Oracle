import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ConsultService } from "../../core/consult.js";
import type { ProjectConfig } from "../../config/project.js";
import type { MemoryPort } from "../../orchestrator/ports.js";
import type { ProfileStore } from "../../identity/profile.js";
import { runConsultPipeline } from "../pipeline/consultPipeline.js";
import type { PipelineDeps } from "../pipeline/consultPipeline.js";
import {
  SoulSchema,
  FilesSchema,
  IncludeDocsSchema,
  GitDiffSchema,
  GitStagedSchema,
  AstResolveSchema,
  WebSearchSchema,
  DeepResearchSchema,
  CreateImageSchema,
} from "../pipeline/schema.js";

export function registerConsultTool(
  server: McpServer,
  deps: PipelineDeps
): void {
  server.registerTool(
    "oracle_ask",
    {
      title: "Ask Oracle",
      description:
        "Ask anything. Stored project memory relevant to the question is recalled automatically " +
        "(`include_memory: false` to skip). Pass `files` to read code, `conversationId` for " +
        "multi-turn recall, or `accountMemory` to explicitly save a high-level fact to the " +
        "signed-in ChatGPT account.",
      inputSchema: {
        question: z.string().min(1).describe("Your question or what you're stuck on"),
        soul: SoulSchema,
        context: z
          .string()
          .optional()
          .describe("Additional context: code snippets, error messages, what you've tried"),
        files: FilesSchema,
        backend: z
          .enum(["codex", "openai", "anthropic", "opencode", "gemini", "chatgpt-browser"])
          .optional()
          .describe("Execution backend override"),
        conversationId: z
          .string()
          .optional()
          .describe(
            "Stable id for this exchange — pass the same value across multiple oracle_ask calls so Oracle recalls what it already said"
          ),
        accountMemory: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            "Explicit opt-in: exact high-level fact or preference to save to the signed-in ChatGPT account's Saved Memory. Requires backend='chatgpt-browser'; never use for secrets or large text."
          ),
        include_docs: IncludeDocsSchema,
        doc_search: z
          .string()
          .optional()
          .describe("Specific doc query (defaults to using the question itself)"),
        include_memory: z
          .boolean()
          .optional()
          .describe("Recall stored project memory relevant to the question. Default: true"),
        no_citations: z
          .boolean()
          .optional()
          .describe("Disable memory and documentation citation references"),
        active_file: z
          .string()
          .optional()
          .describe("Active open file path in the client IDE"),
        cursor_position: z
          .object({ line: z.number(), column: z.number() })
          .optional()
          .describe("Cursor position in active_file { line, column }"),
        git_diff: GitDiffSchema,
        git_staged: GitStagedSchema,
        ast_resolve: AstResolveSchema,
        compress_context: z
          .boolean()
          .optional()
          .describe("Compress AST dependency files into signature skeletons to save tokens"),
        web_search: WebSearchSchema,
        deep_research: DeepResearchSchema,
        create_image: CreateImageSchema,
      },
    },
    async ({
      question,
      soul,
      context,
      files,
      backend,
      conversationId,
      accountMemory,
      include_docs,
      doc_search,
      include_memory,
      no_citations,
      active_file,
      cursor_position,
      git_diff,
      git_staged,
      ast_resolve,
      compress_context,
      web_search,
      deep_research,
      create_image,
    }) => {
      return runConsultPipeline(
        {
          prompt: question,
          preset: "review",
          context,
          activeFile: active_file,
          cursorPosition: cursor_position,
          backend,
          accountMemory,
          docSearch: doc_search,
          compressContext: compress_context,
          files,
          gitDiff: git_diff,
          gitStaged: git_staged,
          astResolve: ast_resolve,
          includeDocs: include_docs,
          includeMemory: include_memory,
          noCitations: no_citations,
          conversationId,
          soul,
          webSearch: web_search,
          deepResearch: deep_research,
          createImage: create_image,
        },
        deps
      );
    }
  );
}
