import { describe, test, expect } from "vitest";
import { CHATGPT_SELECTORS } from "./selectors.js";

describe("ChatGPT Browser ARIA Selectors", () => {
  test("contains all required selector categories with ARIA fallbacks", () => {
    expect(CHATGPT_SELECTORS.promptInput).toContain("[role='textbox']");
    expect(CHATGPT_SELECTORS.sendButton).toContain("button[aria-label*='Send' i]");
    expect(CHATGPT_SELECTORS.responseContainer).toContain("[role='article'] .markdown");
    expect(CHATGPT_SELECTORS.modelSelector.length).toBeGreaterThan(0);
    expect(CHATGPT_SELECTORS.cloudflareChallenge.length).toBeGreaterThan(0);
  });
});
