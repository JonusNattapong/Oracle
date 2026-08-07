import { describe, expect, it } from "vitest";
import { extractCodeDependencies } from "./astGraph.js";

describe("AST Dependency Extractor", () => {
  it("extracts TypeScript import and export symbols", () => {
    const code = `
      import { MemoryAdapter, MemoryType } from "./adapter.js";
      import path from "node:path";

      export interface Config { key: string }
      export class Service {}
      export function run() {}
    `;

    const deps = extractCodeDependencies(code, "src/service.ts");
    expect(deps.moduleName).toBe("service.ts");
    expect(deps.imports).toContain("MemoryAdapter");
    expect(deps.imports).toContain("MemoryType");
    expect(deps.exports).toContain("Config");
    expect(deps.exports).toContain("Service");
    expect(deps.exports).toContain("run");
  });
});
