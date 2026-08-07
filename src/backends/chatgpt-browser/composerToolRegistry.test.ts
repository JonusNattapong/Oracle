import { describe, expect, test } from "vitest";
import {
  COMPOSER_TOOL_LABELS,
  COMPOSER_TOOL_MIN_TIMEOUT_MS,
  COMPOSER_TOOLS_WITHOUT_STALL_RELOAD,
  type ChatGptComposerTool
} from "./types.js";

const ALL_TOOLS: ChatGptComposerTool[] = ["web-search", "deep-research", "create-image"];

describe("composer tool registry", () => {
  test("every tool has a menu label and a timeout floor", () => {
    // The registry is keyed by the tool union, so a tool added to the union
    // without a label would fail to compile. This asserts the values are real
    // rather than placeholders.
    for (const tool of ALL_TOOLS) {
      expect(COMPOSER_TOOL_LABELS[tool]).toMatch(/\S/);
      expect(COMPOSER_TOOL_MIN_TIMEOUT_MS[tool]).toBeGreaterThanOrEqual(0);
    }
  });

  test("Create image is listed under the label the composer menu shows", () => {
    expect(COMPOSER_TOOL_LABELS["create-image"]).toBe("Create image");
  });

  test("image generation gets a timeout floor above the default turn budget", () => {
    // The default turn budget is 180s. An image render can sit past that with
    // no incremental text, and timing out discards a finished generation.
    const DEFAULT_TURN_BUDGET_MS = 180_000;
    expect(COMPOSER_TOOL_MIN_TIMEOUT_MS["create-image"]).toBeGreaterThan(DEFAULT_TURN_BUDGET_MS);
  });

  test("tools that render silently are exempt from the stall reload", () => {
    // Reloading the page mid-render throws the image away; it does not
    // re-request it. Web search streams text, so the reload still rescues it.
    expect(COMPOSER_TOOLS_WITHOUT_STALL_RELOAD.has("create-image")).toBe(true);
    expect(COMPOSER_TOOLS_WITHOUT_STALL_RELOAD.has("deep-research")).toBe(true);
    expect(COMPOSER_TOOLS_WITHOUT_STALL_RELOAD.has("web-search")).toBe(false);
  });
});
