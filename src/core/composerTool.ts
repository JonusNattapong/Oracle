import { OracleError } from "../errors.js";
import type { ConsultRequest } from "../types.js";

export type ComposerTool = NonNullable<ConsultRequest["tool"]>;

/** Caller-facing switches, one per composer tool. */
export interface ComposerToolFlags {
  webSearch?: boolean;
  deepResearch?: boolean;
  createImage?: boolean;
}

/** Flag name each tool is requested under, for error messages. */
const FLAGS: ReadonlyArray<{ tool: ComposerTool; cli: string }> = [
  { tool: "web-search", cli: "--web-search" },
  { tool: "deep-research", cli: "--deep-research" },
  { tool: "create-image", cli: "--create-image" }
];

/**
 * Pick the single composer tool to engage for a turn.
 *
 * ChatGPT's composer accepts one tool at a time. Two flags is a caller mistake,
 * not something to silently resolve by precedence: a request that asked for
 * Deep research and got an image back has no way to tell that its second flag
 * was dropped.
 */
export function resolveComposerTool(flags: ComposerToolFlags): ComposerTool | undefined {
  const requested = FLAGS.filter(({ tool }) => {
    if (tool === "web-search") return Boolean(flags.webSearch);
    if (tool === "deep-research") return Boolean(flags.deepResearch);
    return Boolean(flags.createImage);
  });

  if (requested.length > 1) {
    throw new OracleError(
      "ORACLE_INVALID_REQUEST",
      `Only one ChatGPT composer tool can be engaged per turn; got ${requested
        .map(({ cli }) => cli)
        .join(" and ")}.`,
      "Choose one tool for this turn and run the others separately."
    );
  }

  return requested[0]?.tool;
}
