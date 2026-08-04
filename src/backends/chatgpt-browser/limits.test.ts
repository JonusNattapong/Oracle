import { describe, expect, it } from "vitest";
import { detectRateLimit } from "./limits.js";

describe("detectRateLimit", () => {
  it.each([
    "You've reached your limit for GPT-5.",
    "You've hit your Free plan limit.",
    "Your usage cap has been reached.",
    "Upgrade to continue.",
    "Please try again after 2 hours.",
    "You've reached the limit for o3-mini."
  ])("detects %s", (notice) => {
    expect(detectRateLimit(notice).limited).toBe(true);
  });

  it("extracts a reset time", () => {
    expect(detectRateLimit("You've reached your limit. Try again after 45 minutes.")).toEqual({
      limited: true,
      retryAfter: "45 minutes"
    });
  });

  it.each([
    "The limit is 100 characters per field.",
    "This answer has a usage limit section.",
    "You can limit retries with a timeout."
  ])("does not flag an ordinary answer: %s", (answer) => {
    expect(detectRateLimit(answer)).toEqual({ limited: false });
  });
});
