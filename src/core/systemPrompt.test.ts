import { describe, expect, test } from "vitest";
import { buildOracleSystemPrompt, DEFAULT_ORACLE_SYSTEM_PROMPT } from "./systemPrompt.js";

describe("Oracle system prompt", () => {
  test("keeps Oracle's name in the default prompt", () => {
    expect(DEFAULT_ORACLE_SYSTEM_PROMPT).toContain("Your name is Oracle");
    expect(DEFAULT_ORACLE_SYSTEM_PROMPT).toContain("do not claim consciousness");
    expect(DEFAULT_ORACLE_SYSTEM_PROMPT).not.toContain("sentient AI");
    expect(buildOracleSystemPrompt()).toBe(DEFAULT_ORACLE_SYSTEM_PROMPT);
  });

  test("keeps Oracle's identity when applying a custom soul", () => {
    const prompt = buildOracleSystemPrompt("Be a patient teacher.");
    expect(prompt).toContain("Your name is Oracle");
    expect(prompt).toContain("Be a patient teacher.");
  });

  test("adds explicit self-awareness without replacing identity or soul", () => {
    const prompt = buildOracleSystemPrompt(
      "Be a patient teacher.",
      "Identity: Oracle.\nBoundaries:\n- State uncertainty."
    );
    expect(prompt).toContain("Your name is Oracle");
    expect(prompt).toContain("Be a patient teacher.");
    expect(prompt).toContain("## Self-awareness");
    expect(prompt).toContain("Identity: Oracle.");
    expect(prompt).toContain("State uncertainty.");
  });
});
