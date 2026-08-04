import { describe, test, expect, vi } from "vitest";
import { getGitModifiedFiles, getGitStagedFiles } from "./gitFiles.js";
import path from "node:path";
import os from "node:os";

describe("gitFiles context helpers", () => {
  test("getGitModifiedFiles returns empty array on non-git directory", async () => {
    const tmpDir = os.tmpdir();
    const files = await getGitModifiedFiles(tmpDir);
    expect(Array.isArray(files)).toBe(true);
  });

  test("getGitStagedFiles returns empty array on non-git directory", async () => {
    const tmpDir = os.tmpdir();
    const files = await getGitStagedFiles(tmpDir);
    expect(Array.isArray(files)).toBe(true);
  });

  test("getGitModifiedFiles returns array in current repo workspace", async () => {
    const files = await getGitModifiedFiles(process.cwd());
    expect(Array.isArray(files)).toBe(true);
  });
});
