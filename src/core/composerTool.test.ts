import { describe, expect, test } from "vitest";
import { OracleError } from "../errors.js";
import { resolveComposerTool } from "./composerTool.js";

describe("resolveComposerTool", () => {
  test("returns undefined when no tool is requested", () => {
    expect(resolveComposerTool({})).toBeUndefined();
    expect(
      resolveComposerTool({ webSearch: false, deepResearch: false, createImage: false })
    ).toBeUndefined();
  });

  test("maps each flag to its composer tool", () => {
    expect(resolveComposerTool({ webSearch: true })).toBe("web-search");
    expect(resolveComposerTool({ deepResearch: true })).toBe("deep-research");
    expect(resolveComposerTool({ createImage: true })).toBe("create-image");
  });

  test("rejects two tools rather than picking one by precedence", () => {
    // The old inline ternary silently preferred deep research. A caller that
    // asked for an image and got a research report had no way to see that its
    // flag was dropped.
    expect(() => resolveComposerTool({ deepResearch: true, createImage: true })).toThrow(
      OracleError
    );
    expect(() => resolveComposerTool({ webSearch: true, deepResearch: true })).toThrow(
      /Only one ChatGPT composer tool/
    );
  });

  test("names both offending flags so the caller knows what to drop", () => {
    try {
      resolveComposerTool({ webSearch: true, createImage: true });
      expect.unreachable("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OracleError);
      expect((error as OracleError).message).toContain("--web-search");
      expect((error as OracleError).message).toContain("--create-image");
      expect((error as OracleError).code).toBe("ORACLE_INVALID_REQUEST");
    }
  });
});
