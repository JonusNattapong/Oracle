/**
 * AST Context Compressor
 * Replaces function and method implementation bodies with lightweight signature skeletons
 * to maximize token budget efficiency while preserving type definitions and API surfaces.
 */

export interface CompressionResult {
  compressedContent: string;
  originalBytes: number;
  compressedBytes: number;
  savingsPercentage: number;
}

/**
 * Collapses function and method bodies in TypeScript/JavaScript source code to signatures.
 */
export function compressToSignatures(content: string): string {
  const lines = content.split("\n");
  const resultLines: string[] = [];

  let inFunctionBody = false;
  let braceDepth = 0;
  let skippedLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if line starts a function/method declaration
    const isHeader =
      /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\b/.test(trimmed) ||
      /^(?:public|private|protected|async|static|get|set|\*)*\s*[\w$]+\s*\(.*?\)\s*(?::.*?)?\s*\{/.test(trimmed);

    // Always preserve imports, exports, type definitions, interfaces, enums, and comments
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export type ") ||
      trimmed.startsWith("export interface ") ||
      trimmed.startsWith("export enum ") ||
      trimmed.startsWith("type ") ||
      trimmed.startsWith("interface ") ||
      trimmed.startsWith("enum ") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed === ""
    ) {
      if (!inFunctionBody) {
        resultLines.push(line);
      }
      continue;
    }

    // Count opening and closing braces to track depth
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    if (!inFunctionBody) {
      resultLines.push(line);

      // Detect start of a function/method body block
      if (openBraces > closeBraces && (isHeader || line.includes("function") || line.includes("=>"))) {
        inFunctionBody = true;
        braceDepth = openBraces - closeBraces;
        resultLines.push("    /* ... implementation omitted ... */");
      }
    } else {
      braceDepth += openBraces - closeBraces;
      skippedLines++;

      // When brace depth returns to 0, function body is finished
      if (braceDepth <= 0) {
        inFunctionBody = false;
        braceDepth = 0;
        resultLines.push(line); // Closing brace
      }
    }
  }

  return resultLines.join("\n");
}

/**
 * Compresses content and returns metadata about bytes saved.
 */
export function compressWithMetadata(content: string): CompressionResult {
  const compressedContent = compressToSignatures(content);
  const originalBytes = Buffer.byteLength(content, "utf8");
  const compressedBytes = Buffer.byteLength(compressedContent, "utf8");
  const savingsPercentage =
    originalBytes > 0 ? Math.round(((originalBytes - compressedBytes) / originalBytes) * 100) : 0;

  return {
    compressedContent,
    originalBytes,
    compressedBytes,
    savingsPercentage
  };
}
