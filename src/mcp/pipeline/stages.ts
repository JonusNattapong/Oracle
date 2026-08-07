import { loadSoul } from "../../core/souls.js";
import { buildOracleSystemPrompt } from "../../core/systemPrompt.js";
import { getConversationContext } from "../../core/selfMemory.js";
import { buildMemoryContext } from "../../core/memoryContext.js";
import { searchDocs } from "../../docs/reader.js";
import { getGitModifiedFiles, getGitStagedFiles } from "../../context/gitFiles.js";
import { resolveAstDependencies } from "../../context/astResolver.js";
import type { Citation } from "../../core/citations.js";
import type { PipelineInput, PipelineDeps } from "./consultPipeline.js";

/* ------------------------------------------------------------------ *
 * Stage 1 — resolve identity / soul / system prompt
 * Lifted verbatim from consult.ts L84–102.
 * ------------------------------------------------------------------ */

export async function resolveIdentity(
  input: PipelineInput,
  deps: PipelineDeps
): Promise<{ soulName: string; systemPrompt: string }> {
  let soulName: string;
  let soulPrompt: string | undefined;

  if (input.soul !== undefined) {
    const trimmed = input.soul.trim();
    if (trimmed === "") {
      soulName = "auto";
    } else {
      soulName = trimmed;
      soulPrompt = await loadSoul(soulName, deps.soulsDir);
    }
  } else {
    soulName = "auto";
  }

  const targetBackend = input.backend ?? deps.providerId;
  const awarenessContext = await deps.profile.buildAwarenessContext({
    workspaceRoot: deps.workspaceRoot,
    interface: "mcp",
    backend: targetBackend,
  });
  const systemPrompt = buildOracleSystemPrompt(soulPrompt, awarenessContext);
  return { soulName, systemPrompt };
}

/* ------------------------------------------------------------------ *
 * Stage 2 — gather context block
 * Lifted verbatim from consult.ts L103–140.
 * ------------------------------------------------------------------ */

export async function gatherContext(
  input: PipelineInput,
  deps: PipelineDeps
): Promise<{ contextBlock: string; citations: Citation[] }> {
  const question = input.prompt;
  let ctxBlock = input.context
    ? `\n\n## Context from the asking agent\n${input.context}`
    : "";
  const citations: Citation[] = [];

  if (input.activeFile) {
    ctxBlock += `\n\n## Active Editor Context\nFile: ${input.activeFile}${
      input.cursorPosition
        ? ` (line ${input.cursorPosition.line}, col ${input.cursorPosition.column})`
        : ""
    }`;
  }

  if (input.conversationId) {
    ctxBlock += await getConversationContext(deps.memory, input.conversationId);
  }

  if (input.includeMemory !== false) {
    // Recall is best-effort: losing it degrades the answer but does not
    // make the question unanswerable, so report and continue.
    try {
      const recalled = await buildMemoryContext(deps.memory, question, { includeCitations: input.noCitations !== true });
      ctxBlock += recalled.block;
      citations.push(...recalled.citations);
      if (input.noCitations !== true && recalled.used === 0 && recalled.omitted === 0) {
        ctxBlock += "\n\n## Recalled project memory\nNo matching project memory was found for this question. Answer without claiming memory support.";
      }
      if (recalled.used === 0 && recalled.omitted > 0) {
        console.error(
          `[memory] ${recalled.omitted} recalled item(s) did not fit the context budget; answering without project memory.`
        );
      }
    } catch (error) {
      console.error(
        `[memory] recall failed, answering without project memory: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (input.includeDocs) {
    const docQuery = input.docSearch ?? question;
    const matched = await searchDocs(deps.workspaceRoot, docQuery, 5);
    if (matched.length > 0) {
      const docsBlock = matched
        .map((d, index) => {
          const ref = `d${index + 1}`;
          if (input.noCitations !== true) {
            citations.push({ ref, id: `${d.name}${d.heading ? `#${d.heading}` : ""}`, kind: "doc", label: d.name, path: d.name });
          }
          return `### ${input.noCitations === true ? "" : `[${ref}] `}${d.name}${d.heading ? ` — ${d.heading}` : ""}\n${d.snippet}`;
        })
        .join("\n\n");
      ctxBlock += `\n\n## Documentation from .oracle/docs/\n${docsBlock}\n\n(Match: "${docQuery}")`;
    }
  }

  return { contextBlock: ctxBlock, citations };
}

/* ------------------------------------------------------------------ *
 * Stage 3 — collect files (git, ast, dedupe)
 * Lifted from consult.ts L142–158.  The active_file push is kept
 * because relay passes activeFile = undefined (no-op).
 * ------------------------------------------------------------------ */

export async function collectFiles(
  input: PipelineInput,
  deps: PipelineDeps
): Promise<{ files: string[]; astFiles: string[] }> {
  const filesToInclude: string[] = [...(input.files ?? [])];
  if (input.activeFile) {
    filesToInclude.push(input.activeFile);
  }
  if (input.gitDiff) {
    filesToInclude.push(...(await getGitModifiedFiles(deps.workspaceRoot)));
  }
  if (input.gitStaged) {
    filesToInclude.push(...(await getGitStagedFiles(deps.workspaceRoot)));
  }
  const uniqueFiles = [...new Set(filesToInclude)];
  let astFiles: string[] = [];
  if (input.astResolve && uniqueFiles.length > 0) {
    astFiles = await resolveAstDependencies(uniqueFiles, deps.workspaceRoot, 1);
    uniqueFiles.push(...astFiles);
  }
  const finalFiles = [...new Set(uniqueFiles)];
  return { files: finalFiles, astFiles };
}
