import fs from "node:fs/promises";
import path from "node:path";
import { extractCodeDependencies } from "../memory/astGraph.js";

const FILE_EXTENSIONS = [".ts", ".js", ".tsx", ".jsx", ".json", "/index.ts", "/index.js"];

/**
 * Resolves local relative imported file paths from entry files within the workspace root.
 */
export async function resolveAstDependencies(
  entryFilePaths: string[],
  cwd: string,
  maxDepth = 1
): Promise<string[]> {
  const resolved = new Set<string>();
  const queue: Array<{ filePath: string; depth: number }> = entryFilePaths.map((p) => ({
    filePath: p,
    depth: 0
  }));

  const visited = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift()!;
    const normPath = item.filePath.replaceAll("\\", "/");
    if (visited.has(normPath)) continue;
    visited.add(normPath);

    if (item.depth > maxDepth) continue;

    const absolutePath = path.resolve(cwd, item.filePath);
    let content: string;
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    // Extract import specifiers: e.g. import { foo } from "./bar.js" or import "./bar"
    const relativeImportRegex = /import\s+[\s\S]*?\s+from\s+["'](\.[^"']+)["']|import\s+["'](\.[^"']+)["']/g;
    let match: RegExpExecArray | null;

    const fileDir = path.dirname(absolutePath);

    while ((match = relativeImportRegex.exec(content)) !== null) {
      const importPath = match[1] || match[2];
      if (!importPath) continue;

      const candidates: string[] = [];
      const baseTarget = path.resolve(fileDir, importPath);

      candidates.push(baseTarget);
      for (const ext of FILE_EXTENSIONS) {
        candidates.push(baseTarget + ext);
        // Replace .js / .js specifier with .ts if needed
        if (baseTarget.endsWith(".js")) {
          candidates.push(baseTarget.slice(0, -3) + ".ts");
        }
      }

      for (const cand of candidates) {
        try {
          const stat = await fs.stat(cand);
          if (stat.isFile()) {
            const rel = path.relative(cwd, cand).replaceAll("\\", "/");
            if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
              if (!visited.has(rel)) {
                resolved.add(rel);
                if (item.depth < maxDepth) {
                  queue.push({ filePath: rel, depth: item.depth + 1 });
                }
              }
              break;
            }
          }
        } catch {
          // File extension attempt didn't exist
        }
      }
    }
  }

  // Remove files that were already in entryFilePaths
  const entrySet = new Set(entryFilePaths.map((p) => p.replaceAll("\\", "/")));
  return Array.from(resolved).filter((p) => !entrySet.has(p));
}
