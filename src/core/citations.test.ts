import { describe, expect, test } from "vitest";
import { extractCitationRefs, validateCitations } from "./citations.js";

describe("citation validation", () => {
  test("extracts known citation syntax once and case-insensitively", () => {
    expect(extractCitationRefs("See [M1], [m1], and [d2].")).toEqual(["m1", "d2"]);
  });

  test("reports citations that were not supplied in context", () => {
    const result = validateCitations("Grounded [m1], suspicious [m9].", [
      { ref: "m1", id: "memory-1", kind: "memory", label: "fact" }
    ]);
    expect(result).toEqual({ used: ["m1"], unknown: ["m9"] });
  });
});
