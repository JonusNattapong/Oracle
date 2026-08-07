import { OracleError, serializeOracleError } from "../../errors.js";
import { recordSelfLog } from "../../core/selfMemory.js";
import { resolveComposerTool } from "../../core/composerTool.js";
import { validateCitations, type Citation } from "../../core/citations.js";
import type { ConsultService } from "../../core/consult.js";
import type { ProjectConfig } from "../../config/project.js";
import type { MemoryPort } from "../../orchestrator/ports.js";
import type { ProfileStore } from "../../identity/profile.js";
import type { ConsultResult } from "../../types.js";
import { success, failure } from "../response.js";
import {
  resolveIdentity,
  gatherContext,
  collectFiles,
} from "./stages.js";

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

export interface PipelineDeps {
  service: ConsultService;
  config: ProjectConfig;
  workspaceRoot: string;
  providerId: string;
  memory: MemoryPort;
  profile: ProfileStore;
  soulsDir: string;
}

export interface PipelineInput {
  prompt: string;
  preset: string;
  agent?: string;

  /* ask-specific (optional) */
  context?: string;
  activeFile?: string;
  cursorPosition?: { line: number; column: number };
  backend?: string;
  accountMemory?: string;
  docSearch?: string;
  compressContext?: boolean;

  /* common toggles */
  files?: string[];
  gitDiff?: boolean;
  gitStaged?: boolean;
  astResolve?: boolean;
  includeDocs?: boolean;
  includeMemory?: boolean;
  noCitations?: boolean;
  conversationId?: string;
  soul?: string;
  webSearch?: boolean;
  deepResearch?: boolean;
  createImage?: boolean;
}

export interface PipelineContext {
  prompt: string;
  soulName: string;
  systemPrompt: string;
  contextBlock: string;
  files: string[];
  astFiles: string[];
  citations: Citation[];
  conversationId?: string;
  state: Record<string, unknown>;
}

export interface ConsultHooks {
  onBeforeExecute?(ctx: PipelineContext): Promise<void>;
  onAfterExecute?(
    ctx: PipelineContext,
    result: ConsultResult
  ): Promise<Record<string, unknown>>;
}

export type PipelineOutcome = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/* ------------------------------------------------------------------ *
 * Orchestrator
 * ------------------------------------------------------------------ */

export async function runConsultPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
  hooks?: ConsultHooks
): Promise<PipelineOutcome> {
  const targetBackend = input.backend ?? deps.providerId;

  try {
    const composerTool = resolveComposerTool({
      webSearch: input.webSearch,
      deepResearch: input.deepResearch,
      createImage: input.createImage
    });

    /* Stage 1 — identity / soul / system prompt */
    const { soulName, systemPrompt } = await resolveIdentity(input, deps);

    /* Stage 2 — context block (memory recall, docs, conversation) */
    const { contextBlock, citations } = await gatherContext(input, deps);

    /* Stage 3 — file collection (explicit, git, ast) */
    const { files, astFiles } = await collectFiles(input, deps);

    const ctx: PipelineContext = {
      prompt: input.prompt,
      soulName,
      systemPrompt,
      contextBlock,
      files,
      astFiles,
      citations,
      conversationId: input.conversationId,
      state: {},
    };

    /* Stage 4a — pre-execution hook (relay archives the request) */
    await hooks?.onBeforeExecute?.(ctx);

    /* Stage 4b — execute consult */
    const question = `${contextBlock}\n\n## Question\n${input.prompt}`;
    const hasFiles = files.length > 0;
    const result = await deps.service.consult({
      prompt: question,
      title: input.prompt,
      preset: input.preset,
      provider: targetBackend,
      conversationId: input.conversationId,
      accountMemory: input.accountMemory,
      tool: composerTool,
      files: hasFiles ? files : [],
      compressContext: Boolean(input.compressContext),
      compressFiles: astFiles.length > 0 ? astFiles : undefined,
      model: deps.config.model,
      cwd: deps.workspaceRoot,
      maxFileSizeBytes: deps.config.maxFileSizeBytes,
      maxInputBytes: deps.config.maxInputBytes,
      systemPrompt,
      allowEmptyFiles: !hasFiles,
      agent: input.agent,
    });

    if (result.status !== "completed") {
      throw new OracleError(
        "ORACLE_PROVIDER_UNAVAILABLE",
        result.error ?? `Backend '${targetBackend}' failed to answer.`,
        "Run oracle_doctor for the selected backend and retry."
      );
    }

    /* Stage 5 — persist conversation turn */
    if (input.conversationId) {
      await recordSelfLog(deps.memory, input.conversationId, {
        question: input.prompt,
        answerSummary: result.output.slice(0, 400),
      });
    }

    /* Stage 6a — post-execution hook (relay archives the Q&A) */
    const hookData =
      (await hooks?.onAfterExecute?.(ctx, result)) ?? {};
    const citationValidation = validateCitations(result.output, citations);

    /* Stage 6b — present result */
    return await success(
      result.output,
      {
        soul: soulName,
        sessionId: result.sessionId,
        responseId: result.responseId,
        conversationId: result.conversationId,
        accountMemoryRequested: result.accountMemoryRequested,
        accountMemorySaved: result.accountMemorySaved,
        accountMemoryVerification: result.accountMemoryVerification,
        filesIncluded: result.files.length,
        images: result.images ?? [],
        artifactWarnings: result.artifactWarnings ?? [],
        usage: result.usage,
        citations,
        citationValidation,
        ...hookData,
      },
      result.images
    );
  } catch (error) {
    return failure(error);
  }
}
