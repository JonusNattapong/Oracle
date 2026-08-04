import { describe, test, expect } from "vitest";
import { resolveAstDependencies } from "./astResolver.js";
import path from "node:path";

describe("resolveAstDependencies", () => {
  test("resolves local relative imports from entry file", async () => {
    const cwd = process.cwd();
    // src/context/bundleService.ts imports ./files.js and ./secrets.js
    const entry = "src/context/bundleService.ts";
    const deps = await resolveAstDependencies([entry], cwd, 1);
    expect(deps).toContain("src/context/files.ts");
    expect(deps).toContain("src/context/secrets.ts");
  });

  test("returns empty array for non-existent file", async () => {
    const cwd = process.cwd();
    const deps = await resolveAstDependencies(["src/nonexistent_file_xyz.ts"], cwd, 1);
    expect(deps).toEqual([]);
  });
});
