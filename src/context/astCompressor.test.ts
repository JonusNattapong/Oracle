import { describe, test, expect } from "vitest";
import { compressToSignatures, compressWithMetadata } from "./astCompressor.js";

describe("AST Context Compressor", () => {
  test("preserves interfaces, types, imports, and function signatures while omitting body", () => {
    const code = `
import fs from "node:fs";
import path from "node:path";

export interface User {
  id: string;
  name: string;
}

export type Status = "active" | "inactive";

/**
 * Calculates user score
 */
export function calculateScore(user: User): number {
  const base = 100;
  let bonus = 0;
  for (let i = 0; i < 10; i++) {
    bonus += i * 2;
  }
  return base + bonus;
}
`;

    const compressed = compressToSignatures(code);
    expect(compressed).toContain("import fs from \"node:fs\";");
    expect(compressed).toContain("export interface User {");
    expect(compressed).toContain("export type Status = \"active\" | \"inactive\";");
    expect(compressed).toContain("export function calculateScore(user: User): number {");
    expect(compressed).toContain("/* ... implementation omitted ... */");
    expect(compressed).not.toContain("let bonus = 0;");
  });

  test("compressWithMetadata calculates byte savings correctly", () => {
    const code = `
function longProcess() {
  console.log("line 1");
  console.log("line 2");
  console.log("line 3");
  console.log("line 4");
  console.log("line 5");
}
`;
    const res = compressWithMetadata(code);
    expect(res.originalBytes).toBeGreaterThan(res.compressedBytes);
    expect(res.savingsPercentage).toBeGreaterThan(0);
  });
});
