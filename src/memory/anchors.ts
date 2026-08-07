import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AnchorFreshness = "fresh" | "drifted" | "missing" | "unavailable";

export interface MemoryAnchor {
  /** Workspace-relative path, normalized with forward slashes. */
  path: string;
  /** Repository commit at the time the memory was written. */
  commit: string;
  /** Git blob id for the file contents at write time. */
  blobSha?: string;
  /** Optional 1-based inclusive line range. */
  lines?: [number, number];
}

export interface AnchorStatus {
  path: string;
  state: AnchorFreshness;
  commit?: string;
  blobSha?: string;
  reason?: string;
}

export interface AnchorVerificationReport {
  totalAnchored: number;
  fresh: number;
  drifted: number;
  missing: number;
  unavailable: number;
  entries: Array<{ id: string; type: string; statuses: AnchorStatus[] }>;
}

export interface AnchorInput {
  path: string;
  lines?: [number, number];
}

function normalizeRelative(rootDir: string, filePath: string): { absolute: string; relative: string } {
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Anchor path must be inside the workspace: ${filePath}`);
  }
  return { absolute, relative: relative.split(path.sep).join("/") };
}

async function gitInfo(rootDir: string): Promise<{ commit: string; objectFormat: "sha1" | "sha256" }> {
  try {
    const { stdout: commitOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" });
    const commit = String(commitOut).trim();
    if (!commit) throw new Error("Git repository has no HEAD commit");
    let objectFormat: "sha1" | "sha256" = "sha1";
    try {
      const { stdout: formatOut } = await execFileAsync("git", ["rev-parse", "--show-object-format"], { cwd: rootDir, encoding: "utf8" });
      objectFormat = String(formatOut).trim() === "sha256" ? "sha256" : "sha1";
    } catch { /* older Git versions default to SHA-1 */ }
    return { commit, objectFormat };
  } catch (error) {
    throw new Error(`Unable to read Git repository metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function blobSha(filePath: string, algorithm: "sha1" | "sha256"): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash(algorithm).update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}

export async function captureAnchor(rootDir: string, input: AnchorInput): Promise<MemoryAnchor> {
  const { absolute, relative } = normalizeRelative(rootDir, input.path);
  if (input.lines && (!Number.isInteger(input.lines[0]) || !Number.isInteger(input.lines[1]) || input.lines[0] < 1 || input.lines[1] < input.lines[0])) {
    throw new Error(`Invalid anchor line range for ${input.path}`);
  }
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error(`Anchor path is not a file: ${input.path}`);
  const { commit, objectFormat } = await gitInfo(rootDir);
  return { path: relative, commit, blobSha: await blobSha(absolute, objectFormat), ...(input.lines ? { lines: input.lines } : {}) };
}

export async function captureAnchors(rootDir: string, inputs: AnchorInput[]): Promise<MemoryAnchor[]> {
  return Promise.all(inputs.map((input) => captureAnchor(rootDir, input)));
}

export async function checkAnchor(rootDir: string, anchor: MemoryAnchor, git?: { commit: string; objectFormat: "sha1" | "sha256" }): Promise<AnchorStatus> {
  let resolved: { absolute: string; relative: string };
  try {
    resolved = normalizeRelative(rootDir, anchor.path);
  } catch (error) {
    return { path: anchor.path, state: "missing", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const stat = await fs.stat(resolved.absolute);
    if (!stat.isFile()) return { path: resolved.relative, state: "missing", reason: "Path is not a file" };
  } catch {
    return { path: resolved.relative, state: "missing", reason: "File does not exist" };
  }
  try {
    const info = git ?? await gitInfo(rootDir);
    const currentBlob = await blobSha(resolved.absolute, info.objectFormat);
    const fresh = anchor.blobSha ? currentBlob === anchor.blobSha : info.commit === anchor.commit;
    return {
      path: resolved.relative,
      state: fresh ? "fresh" : "drifted",
      commit: info.commit,
      blobSha: currentBlob,
      ...(fresh ? {} : { reason: anchor.blobSha ? "File content changed" : "Repository commit changed" }),
    };
  } catch (error) {
    return { path: resolved.relative, state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkAnchors(rootDir: string, anchors: MemoryAnchor[]): Promise<AnchorStatus[]> {
  if (anchors.length === 0) return [];
  let git: { commit: string; objectFormat: "sha1" | "sha256" } | undefined;
  try { git = await gitInfo(rootDir); } catch { /* individual statuses become unavailable */ }
  const unique = [...new Map(anchors.map((anchor) => [`${anchor.path}\0${anchor.commit}\0${anchor.blobSha ?? ""}`, anchor])).values()];
  const checked = await Promise.all(unique.map((anchor) => checkAnchor(rootDir, anchor, git)));
  const byKey = new Map(unique.map((anchor, index) => [`${anchor.path}\0${anchor.commit}\0${anchor.blobSha ?? ""}`, checked[index]]));
  return anchors.map((anchor) => byKey.get(`${anchor.path}\0${anchor.commit}\0${anchor.blobSha ?? ""}`)!);
}
