import fs from "node:fs/promises";
import { serializeOracleError } from "../errors.js";

/**
 * Shared MCP tool response helpers.
 *
 * `success` and `failure` were copy-pasted into every tool file under
 * `src/mcp/tools/`.  They are identical in every one of those 13 files, so
 * the canonical definition now lives here and the tool files import it.
 */

export async function success(
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
      mimeType: image.mimeType,
    });
  }
  return { content, structuredContent };
}

export function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>,
  };
}
