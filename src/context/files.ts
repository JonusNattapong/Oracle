import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { ContextFile } from "../types.js";

const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/credentials*.json"
];

function splitPatterns(inputs: string[]): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of inputs) {
    const value = raw.trim();
    if (!value) continue;
    if (value.startsWith("!")) exclude.push(value.slice(1));
    else include.push(value);
  }
  return { include, exclude };
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  return sample.includes(0);
}

function assertInsideWorkingDirectory(candidate: string, cwd: string): void {
  const relative = path.relative(cwd, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`File pattern resolves outside the working directory: ${candidate}`);
  }
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function mimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp"
  };
  return map[ext] ?? "application/octet-stream";
}

export async function resolveFiles(
  patterns: string[],
  options: { cwd: string; maxFileSizeBytes?: number }
): Promise<ContextFile[]> {
  if (patterns.length === 0) return [];

  const maxFileSizeBytes = options.maxFileSizeBytes ?? 1_000_000;
  const cwd = path.resolve(options.cwd);
  const realCwd = await fs.realpath(cwd);
  const { include, exclude } = splitPatterns(patterns);
  if (include.length === 0) return [];

  for (const pattern of include) {
    assertInsideWorkingDirectory(path.resolve(cwd, pattern), cwd);
  }

  const matches = await fg(include, {
    cwd,
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: [...DEFAULT_IGNORES, ...exclude]
  });

  const files: ContextFile[] = [];
  for (const absolutePath of matches.sort()) {
    assertInsideWorkingDirectory(absolutePath, cwd);
    const realPath = await fs.realpath(absolutePath);
    assertInsideWorkingDirectory(realPath, realCwd);
    const stat = await fs.stat(absolutePath);
    if (stat.size > maxFileSizeBytes) continue;
    const ext = path.extname(absolutePath).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const raw = await fs.readFile(absolutePath);
    if (!isImage && looksBinary(raw)) continue;
    files.push({
      path: path.relative(cwd, absolutePath).replaceAll("\\", "/"),
      content: isImage ? `[image: ${path.basename(absolutePath)}]` : raw.toString("utf8"),
      sizeBytes: stat.size,
      base64: isImage ? raw.toString("base64") : undefined,
      mimeType: isImage ? mimeFromExtension(absolutePath) : undefined
    });
  }
  return files;
}
