import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentContext, AgentTool, ContentBlock } from "./types.js";
import { logSandbox } from "../observability/log.js";
import { validateCommand, validateFilePath } from "./policy.js";
import { redactCommand } from "../sandbox/runner.js";

/** Cap on how much text any single tool returns to the model. */
const MAX_OUTPUT_CHARS = 30_000;

class ToolError extends Error {}

/**
 * Resolve `target` through any links, without requiring it to exist yet.
 *
 * fs.realpath throws on a path that is not there, but write_file legitimately
 * names a file it is about to create. Walk up to the nearest ancestor that does
 * exist, canonicalise that, and re-attach the segments below it — so the links
 * that exist are followed and the part that does not exist cannot hide one.
 */
async function canonicalize(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length ? path.join(real, ...missing) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a caller-supplied path against the workspace root and refuse
 * anything that escapes it. This is the single trust boundary for every
 * filesystem tool — no tool should touch a path it did not get from here.
 *
 * The check is on the canonical path, not the lexical one. `path.resolve`
 * normalises `../` but says nothing about what a link points at: a symlink or
 * junction sitting inside the workspace resolves to a path inside the
 * workspace, and the kernel then follows it out. Git carries links in a tree,
 * so cloning a repository was enough to read and write outside the workspace —
 * in read-only mode too, which drops the mutating tools but keeps read_file.
 *
 * Returns the canonical path so callers operate on exactly what was validated
 * rather than re-following the link afterwards.
 */
async function resolveInWorkspace(ctx: AgentContext, rel: string): Promise<string> {
  const root = await canonicalize(path.resolve(ctx.workspaceRoot));
  const abs = await canonicalize(path.resolve(ctx.workspaceRoot, rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    logSandbox("path-escape", { requestedPath: rel, resolvedPath: abs, workspaceRoot: root });
    throw new ToolError(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[... truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

function assertWritable(ctx: AgentContext, tool: string): void {
  if (ctx.readOnly) {
    throw new ToolError(`${tool} is disabled in read-only mode.`);
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new ToolError(`'${key}' must be a string.`);
  return v;
}

function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`'${key}' must be a string.`);
  return v;
}

/**
 * Recursively walk a directory, returning workspace-relative file paths.
 *
 * Links are not followed. They are the same escape the path tools guard
 * against, and here it is worse than a wrong answer: descending a link that
 * points outside would put paths the caller cannot reach into results it reads
 * as workspace contents. Dirent reports a POSIX symlink and a Windows junction
 * differently, so the containment check does not rely on either — anything
 * whose canonical path leaves the root is skipped whatever the OS calls it.
 */
async function walk(dir: string, root: string, acc: string[], limit: number): Promise<void> {
  if (acc.length >= limit) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.length >= limit) return;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(await canonicalize(abs)).startsWith(root + path.sep)) continue;
      await walk(abs, root, acc, limit);
    } else if (entry.isFile()) {
      acc.push(path.relative(root, abs));
    }
  }
}

/**
 * The default toolset: read, write, edit, list, glob, grep, media reads,
 * and shell execution. File tools resolve paths through resolveInWorkspace
 * so the agent can only ever touch files inside the workspace root.
 */
export function defaultAgentTools(): AgentTool[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 file from the workspace.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path" } },
        required: ["path"],
      },
      async execute(input, ctx) {
        const rel = str(input, "path");
        if (ctx.policy) validateFilePath(rel, ctx.policy);
        const abs = await resolveInWorkspace(ctx, rel);
        const content = await fs.readFile(abs, "utf8");
        return truncate(content);
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file. Creates parent dirs.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
      async execute(input, ctx) {
        assertWritable(ctx, "write_file");
        const rel = str(input, "path");
        if (ctx.policy) validateFilePath(rel, ctx.policy);
        const abs = await resolveInWorkspace(ctx, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const content = str(input, "content");
        await fs.writeFile(abs, content, "utf8");
        if (ctx.audit) {
          const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
          ctx.audit.record("write", rel, { sizeBytes: content.length, contentHash: hash });
        }
        await ctx.onFileMutation?.(rel, "write");
        return `Wrote ${content.length} chars to ${rel}`;
      },
    },
    {
      name: "edit_file",
      description: "Replace an exact string (must be unique). For targeted edits.",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          old_string: { type: "string", description: "Exact text to replace (must be unique in the file)" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
      async execute(input, ctx) {
        assertWritable(ctx, "edit_file");
        const rel = str(input, "path");
        if (ctx.policy) validateFilePath(rel, ctx.policy);
        const abs = await resolveInWorkspace(ctx, rel);
        const oldStr = str(input, "old_string");
        const newStr = str(input, "new_string");
        const content = await fs.readFile(abs, "utf8");
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) throw new ToolError(`old_string not found in ${rel}`);
        if (occurrences > 1) throw new ToolError(`old_string appears ${occurrences} times in ${rel}; make it unique.`);
        const newContent = content.replace(oldStr, newStr);
        await fs.writeFile(abs, newContent, "utf8");
        if (ctx.audit) {
          const hash = createHash("sha256").update(newContent).digest("hex").slice(0, 8);
          ctx.audit.record("edit", rel, { sizeBytes: newContent.length, contentHash: hash });
        }
        await ctx.onFileMutation?.(rel, "edit");
        return `Edited ${rel}`;
      },
    },
    {
      name: "list_dir",
      description: "List entries in a workspace directory.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative directory (default: root)" } },
      },
      async execute(input, ctx) {
        const rel = optStr(input, "path") ?? ".";
        const abs = await resolveInWorkspace(ctx, rel);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const lines = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return lines.join("\n") || "(empty)";
      },
    },
    {
      name: "glob",
      description: "Find files by path substring (skips node_modules, .git, dist).",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string", description: "Substring to match in file paths, e.g. '.test.ts'" } },
        required: ["pattern"],
      },
      async execute(input, ctx) {
        const pattern = str(input, "pattern");
        const acc: string[] = [];
        await walk(await canonicalize(ctx.workspaceRoot), await canonicalize(ctx.workspaceRoot), acc, 5000);
        const matches = acc.filter((p) => p.includes(pattern)).sort();
        return truncate(matches.join("\n") || "(no matches)");
      },
    },
    {
      name: "grep",
      description: "Search file contents for a substring. Returns path:line matches.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for" },
          path_filter: { type: "string", description: "Optional: only search files whose path contains this substring" },
        },
        required: ["query"],
      },
      async execute(input, ctx) {
        const query = str(input, "query");
        const pathFilter = optStr(input, "path_filter");
        const files: string[] = [];
        await walk(await canonicalize(ctx.workspaceRoot), await canonicalize(ctx.workspaceRoot), files, 5000);
        const hits: string[] = [];
        for (const rel of files) {
          if (pathFilter && !rel.includes(pathFilter)) continue;
          if (hits.length >= 200) break;
          let content: string;
          try {
            content = await fs.readFile(path.join(ctx.workspaceRoot, rel), "utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(query)) {
              hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              if (hits.length >= 200) break;
            }
          }
        }
        return truncate(hits.join("\n") || "(no matches)");
      },
    },
    {
      name: "read_image",
      description: "Read an image as base64. Supports PNG, JPEG, GIF, WebP.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Image file path (relative to workspace)" },
        },
        required: ["path"],
      },
      async execute(input, ctx) {
        const rel = str(input, "path");
        if (ctx.policy) validateFilePath(rel, ctx.policy);
        const filePath = await resolveInWorkspace(ctx, rel);
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
        }[ext];
        if (!mimeType) throw new ToolError(`Unsupported image format: ${ext}`);
        const contentBlock: ContentBlock = {
          type: "image",
          mimeType,
          data: data.toString("base64"),
        };
        return [contentBlock];
      },
    },
    {
      name: "read_video",
      description: "Read a video as base64. Supports MP4, WebM.",
      mutating: false,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Video file path (relative to workspace)" },
        },
        required: ["path"],
      },
      async execute(input, ctx) {
        const rel = str(input, "path");
        if (ctx.policy) validateFilePath(rel, ctx.policy);
        const filePath = await resolveInWorkspace(ctx, rel);
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = {
          ".mp4": "video/mp4",
          ".webm": "video/webm",
          ".mkv": "video/x-matroska",
        }[ext];
        if (!mimeType) throw new ToolError(`Unsupported video format: ${ext}`);
        const contentBlock: ContentBlock = {
          type: "video",
          mimeType,
          data: data.toString("base64"),
        };
        return [contentBlock];
      },
    },
    {
      name: "bash",
      description:
        "Run a shell command in the workspace root. Use for tests, git, build tools. Timeout 60s (configurable via timeout ms).",
      mutating: true,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 60000, max: 300000)",
          },
        },
        required: ["command"],
      },
      async execute(input, ctx) {
        assertWritable(ctx, "bash");
        const command = str(input, "command");
        if (ctx.policy) validateCommand(command, ctx.policy);
        const timeout = Math.min(Math.max(Number(input.timeout) || 60000, 1000), 300000);
        let stdout: string;
        try {
          if (!ctx.sandbox) throw new Error("Sandbox context is unavailable; refusing command execution.");
          const result = await ctx.sandbox.run(command, timeout);
          stdout = [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
        } catch (error) {
          throw new ToolError(error instanceof Error ? error.message : String(error));
        }
        if (ctx.audit) {
          ctx.audit.record("bash", redactCommand(command).slice(0, 200), { timeout, sandbox: ctx.sandbox.mode });
        }
        return truncate(stdout);
      },
    },
  ];
}
