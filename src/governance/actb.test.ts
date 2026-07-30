import { describe, expect, test } from "vitest";
import { ACTBEngine } from "./actb.js";

describe("ACTBEngine Governance Framework", () => {
  const workspaceRoot = process.cwd();
  const engine = new ACTBEngine(workspaceRoot);

  describe("Pillar I: Awareness Engine", () => {
    test("returns healthy report under normal conditions", () => {
      const report = engine.getAwarenessReport(5, 12, 45);
      expect(report.status).toBe("healthy");
      expect(report.metrics.memoryNodesTracked).toBe(5);
      expect(report.metrics.auditRecordsCount).toBe(12);
      expect(report.metrics.tokenBudgetUsagePct).toBe(45);
    });

    test("returns warning status when budget usage is high", () => {
      const report = engine.getAwarenessReport(10, 50, 95);
      expect(report.status).toBe("warning");
      expect(report.metrics.tokenBudgetUsagePct).toBe(95);
    });
  });

  describe("Pillar II: Control Engine", () => {
    test("allows low-risk actions under normal step limits", () => {
      const result = engine.evaluateControlPolicy({
        actionName: "read_file",
        currentStep: 2,
        maxSteps: 20,
        policyMode: "risky"
      });

      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.riskLevel).toBe("low");
    });

    test("blocks action when maxSteps limit is reached", () => {
      const result = engine.evaluateControlPolicy({
        actionName: "write_file",
        currentStep: 20,
        maxSteps: 20,
        policyMode: "off"
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Exceeded max execution steps");
    });

    test("flag destructive command lines as critical risk requiring approval", () => {
      const result = engine.evaluateControlPolicy({
        actionName: "bash",
        commandLine: "rm -rf /tmp/data",
        currentStep: 5,
        maxSteps: 20,
        policyMode: "risky"
      });

      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(true);
      expect(result.riskLevel).toBe("critical");
    });
  });

  describe("Pillar III: Transform Engine", () => {
    test("normalizes tags and detects duplicates", () => {
      const existing = [
        { tags: ["Memory", "Cache"], content: "Store connection pool details" }
      ];

      const input = {
        tags: ["memory ", "CACHE"],
        content: "Store connection pool details"
      };

      const result = engine.transformMemory(input, existing);
      expect(result.normalizedTags).toEqual(["memory", "cache"]);
      expect(result.isDuplicate).toBe(true);
      expect(result.similarityScore).toBe(1.0);
    });

    test("accepts non-duplicate memories", () => {
      const existing = [
        { tags: ["Database"], content: "PostgreSQL config" }
      ];

      const input = {
        tags: ["Redis", "Memory"],
        content: "Redis caching policy"
      };

      const result = engine.transformMemory(input, existing);
      expect(result.isDuplicate).toBe(false);
      expect(result.similarityScore).toBe(0.0);
    });
  });

  describe("Pillar IV: Boundary Engine", () => {
    test("validates paths strictly within workspace", () => {
      const result = engine.validateBoundary("src/cli.ts");
      expect(result.valid).toBe(true);
      expect(result.isInsideWorkspace).toBe(true);
    });

    test("rejects paths attempting path traversal out of workspace", () => {
      const result = engine.validateBoundary("../../etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.isInsideWorkspace).toBe(false);
    });
  });
});
