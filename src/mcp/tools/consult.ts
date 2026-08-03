import type { McpServer } from "@modelcontextprotocol/server";
import fs from "node:fs/promises";
import { z } from "zod";
import type { ConsultService } from "../../core/consult.js";
import type { ProjectConfig } from "../../config/project.js";
import type { MemoryPort } from "../../orchestrator/ports.js";
import { OracleError, serializeOracleError } from "../../errors.js";
import { getConversationContext, recordSelfLog } from "../../core/selfMemory.js";
import { buildMemoryContext } from "../../core/memoryContext.js";
import { loadSoul } from "../../core/souls.js";
import { buildOracleSystemPrompt } from "../../core/systemPrompt.js";
import { searchDocs } from "../../docs/reader.js";
import type { ProfileStore } from "../../identity/profile.js";

async function success(
  text: string,
  structuredContent: Record<string, unknown>,
  images: Array<{ path: string; mimeType: string }> = []
) {
  const content: Array<
    { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text }];
  for (const image of images) {
    const data = await fs.readFile(image.path);
    content.push({
      type: "image",
      data: data.toString("base64"),
      mimeType: image.mimeType
    });
  }
  return { content, structuredContent };
}

function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>
  };
}

export function registerConsultTool(
  server: McpServer,
  deps: {
    service: ConsultService;
    config: ProjectConfig;
    workspaceRoot: string;
    providerId: string;
    memory: MemoryPort;
    soulsDir: string;
    profile: ProfileStore;
  }
): void {
  server.registerTool(
    "oracle_ask",
    {
      title: "Ask Oracle",
      description: "Ask anything. Stored project memory relevant to the question is recalled automatically (`include_memory: false` to skip). Pass `files` to read code, `conversationId` for multi-turn recall, or `accountMemory` to explicitly save a high-level fact to the signed-in ChatGPT account.",
      inputSchema: {
        question: z.string().min(1).describe("Your question or what you're stuck on"),
        soul: z.string().optional().describe("Soul prompt name (e.g. 'engineer', 'philosopher'). Defaults to 'default'"),
        context: z.string().optional().describe("Additional context: code snippets, error messages, what you've tried"),
        files: z.array(z.string()).optional().describe("File paths or glob patterns to read and include, when the question needs real code (e.g. ['src/**/*.ts'])"),
        backend: z.enum(["codex", "openai", "anthropic", "opencode", "gemini", "chatgpt-browser"]).optional().describe("Execution backend override"),
        conversationId: z.string().optional().describe("Stable id for this exchange — pass the same value across multiple oracle_ask calls so Oracle recalls what it already said"),
        accountMemory: z.string().min(1).max(2000).optional().describe("Explicit opt-in: exact high-level fact or preference to save to the signed-in ChatGPT account's Saved Memory. Requires backend='chatgpt-browser'; never use for secrets or large text."),
        include_docs: z.boolean().optional().describe("Search .oracle/docs/ for relevant documentation and include as context"),
        doc_search: z.string().optional().describe("Specific doc query (defaults to using the question itself)"),
        include_memory: z.boolean().optional().describe("Recall stored project memory relevant to the question. Default: true")
      }
    },
    async ({ question, soul, context, files, backend, conversationId, accountMemory, include_docs, doc_search, include_memory }) => {
      try {
        if (soul !== undefined) {
          soul = soul.trim();
          if (soul === "") soul = undefined;
        }
        let soulName: string;
        let soulPrompt: string | undefined;
        if (soul) {
          soulName = soul;
          soulPrompt = await loadSoul(soulName, deps.soulsDir);
        } else {
          soulName = "auto";
        }
        const targetBackend = backend ?? deps.providerId;
        const awarenessContext = await deps.profile.buildAwarenessContext({
          workspaceRoot: deps.workspaceRoot,
          interface: "mcp",
          backend: targetBackend
        });
        const systemPrompt = buildOracleSystemPrompt(soulPrompt, awarenessContext);
        let ctxBlock = context ? `\n\n## Context from the asking agent\n${context}` : "";

        if (conversationId) {
          ctxBlock += await getConversationContext(deps.memory, conversationId);
        }

        if (include_memory !== false) {
          // Recall is best-effort: losing it degrades the answer but does not
          // make the question unanswerable, so report and continue.
          try {
            const recalled = await buildMemoryContext(deps.memory, question);
            ctxBlock += recalled.block;
            if (recalled.used === 0 && recalled.omitted > 0) {
              console.error(
                `[memory] ${recalled.omitted} recalled item(s) did not fit the context budget; answering without project memory.`
              );
            }
          } catch (error) {
            console.error(
              `[memory] recall failed, answering without project memory: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        if (include_docs) {
          const docQuery = doc_search ?? question;
          const matched = await searchDocs(deps.workspaceRoot, docQuery, 5);
          if (matched.length > 0) {
            const docsBlock = matched
              .map((d) => `### ${d.name}${d.heading ? ` — ${d.heading}` : ""}\n${d.snippet}`)
              .join("\n\n");
            ctxBlock += `\n\n## Documentation from .oracle/docs/\n${docsBlock}\n\n(Match: "${docQuery}")`;
          }
        }

        const prompt = `${ctxBlock}\n\n## Question\n${question}`;
        const hasFiles = files !== undefined && files.length > 0;
        const result = await deps.service.consult({
          prompt,
          title: question,
          preset: "review",
          provider: targetBackend,
          conversationId,
          accountMemory,
          files: hasFiles ? files : [],
          model: deps.config.model,
          cwd: deps.workspaceRoot,
          maxFileSizeBytes: deps.config.maxFileSizeBytes,
          maxInputBytes: deps.config.maxInputBytes,
          systemPrompt,
          allowEmptyFiles: !hasFiles,
        });
        if (result.status !== "completed") {
          throw new OracleError(
            "ORACLE_PROVIDER_UNAVAILABLE",
            result.error ?? `Backend '${targetBackend}' failed to answer.`,
            "Run oracle_doctor for the selected backend and retry."
          );
        }

        if (conversationId) {
          await recordSelfLog(deps.memory, conversationId, { question, answerSummary: result.output.slice(0, 400) });
        }

        return await success(result.output, {
          soul: soulName,
          sessionId: result.sessionId,
          responseId: result.responseId,
          conversationId: result.conversationId,
          accountMemoryRequested: result.accountMemoryRequested,
          accountMemorySaved: result.accountMemorySaved,
          accountMemoryVerification: result.accountMemoryVerification,
          filesIncluded: result.files.length,
          images: result.images ?? [],
          artifactWarnings: result.artifactWarnings ?? []
        }, result.images);
      } catch (error) {
        return failure(error);
      }
    }
  );
}
