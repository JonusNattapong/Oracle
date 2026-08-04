import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Safely fetches modified or staged relative file paths from git.
 */
async function runGitDiff(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const validFiles: string[] = [];
    for (const relPath of lines) {
      const fullPath = path.resolve(cwd, relPath);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) {
          validFiles.push(relPath.replaceAll("\\", "/"));
        }
      } catch {
        // Skip deleted files or invalid paths
      }
    }
    return validFiles;
  } catch {
    // Return empty list if not inside a git repository or git fails
    return [];
  }
}

/**
 * Returns unstaged modified file paths relative to cwd.
 */
export async function getGitModifiedFiles(cwd: string): Promise<string[]> {
  return runGitDiff(cwd, ["diff", "--name-only"]);
}

/**
 * Returns staged file paths relative to cwd.
 */
export async function getGitStagedFiles(cwd: string): Promise<string[]> {
  return runGitDiff(cwd, ["diff", "--name-only", "--cached"]);
}
