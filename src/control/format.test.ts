import { describe, expect, test } from "vitest";
import { clean, riskTone, shortAge, truncate } from "./format.js";

describe("clean", () => {
  test("passes plain text through", () => {
    expect(clean("hello world")).toBe("hello world");
  });

  test("strips C0 control characters", () => {
    expect(clean("hello\x00world\x1b")).toBe("hello world ");
  });

  test("strips C1 control characters", () => {
    expect(clean("hello\x7fworld\x9f")).toBe("hello world ");
  });

  test("handles null/undefined", () => {
    expect(clean(null)).toBe("");
    expect(clean(undefined)).toBe("");
  });

  test("handles numbers", () => {
    expect(clean(42)).toBe("42");
  });
});

describe("truncate", () => {
  test("returns string unchanged when under limit", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  test("truncates with ellipsis when over limit", () => {
    // width 9: 8 chars + ellipsis = 9 visible positions
    expect(truncate("this is a long string", 9)).toBe("this is …");
  });

  test("width 1 returns first char + ellipsis", () => {
    // width 1: 1 char + ellipsis = 2 visible positions (minimum viable)
    expect(truncate("ab", 1)).toBe("a…");
  });

  test("strips control chars before truncating", () => {
    // "hello\x00world" cleaned = "hello world" (11 chars)
    // width 7: slice(0, 6) = "hello " + "…" = "hello …" (7 visible positions)
    expect(truncate("hello\x00world", 7)).toBe("hello …");
  });
});

describe("shortAge", () => {
  test("returns — for undefined", () => {
    expect(shortAge(undefined)).toBe("—");
  });

  test("returns — for invalid date", () => {
    expect(shortAge("not-a-date")).toBe("—");
  });

  test("formats seconds", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    expect(shortAge(recent)).toBe("30s");
  });

  test("formats minutes", () => {
    const recent = new Date(Date.now() - 120_000).toISOString();
    expect(shortAge(recent)).toBe("2m");
  });

  test("formats hours", () => {
    const recent = new Date(Date.now() - 7_200_000).toISOString();
    expect(shortAge(recent)).toBe("2h");
  });

  test("formats days", () => {
    const recent = new Date(Date.now() - 172_800_000).toISOString();
    expect(shortAge(recent)).toBe("2d");
  });
});

describe("riskTone", () => {
  test("high returns danger", () => expect(riskTone("high")).toBe("danger"));
  test("medium returns warn", () => expect(riskTone("medium")).toBe("warn"));
  test("low returns ok", () => expect(riskTone("low")).toBe("ok"));
  test("unknown returns ok", () => expect(riskTone("unknown")).toBe("ok"));
});
