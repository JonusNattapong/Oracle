import { z } from "zod";

/**
 * Shared zod field definitions factored out of consult.ts and relay.ts.
 * Each tool's `inputSchema` spreads the fields it needs from here,
 * guaranteeing that the shared parameters never drift out of sync
 * between the two MCP tools.
 */
export const SoulSchema = z
  .string()
  .optional()
  .describe("Soul prompt name (e.g. 'engineer', 'philosopher'). Defaults to 'default'");

export const FilesSchema = z
  .array(z.string())
  .optional()
  .describe(
    "File paths or glob patterns to read and include, when the question needs real code (e.g. ['src/**/*.ts'])"
  );

export const IncludeDocsSchema = z
  .boolean()
  .optional()
  .describe("Search .oracle/docs/ for relevant documentation and include as context");

export const GitDiffSchema = z
  .boolean()
  .optional()
  .describe("Automatically include modified files in git diff");

export const GitStagedSchema = z
  .boolean()
  .optional()
  .describe("Automatically include staged files in git index");

export const AstResolveSchema = z
  .boolean()
  .optional()
  .describe("Auto-resolve AST dependency files referenced by entry files");
