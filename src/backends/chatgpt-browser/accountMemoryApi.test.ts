import { describe, expect, test } from "vitest";
import {
  readAccountMemories,
  snapshotContains,
  verifyAccountMemoryWrite,
  type PageEvaluator
} from "./accountMemoryApi.js";

/** Stands in for the authenticated page. */
function page(reply: string | Error): PageEvaluator {
  return {
    async evaluateAsync<T>(): Promise<T> {
      if (reply instanceof Error) throw reply;
      return reply as T;
    }
  };
}

const ok = (entries: string[]) => page(JSON.stringify({ known: true, entries }));

describe("readAccountMemories", () => {
  test("returns the account's entries", async () => {
    const result = await readAccountMemories(ok(["prefers small diffs"]));
    expect(result).toEqual({ known: true, entries: ["prefers small diffs"] });
  });

  test("reports unknown when the page cannot be queried", async () => {
    const result = await readAccountMemories(page(new Error("renderer is frozen")));
    expect(result.known).toBe(false);
  });

  test("reports unknown for an unparseable payload", async () => {
    const result = await readAccountMemories(page("not json"));
    expect(result.known).toBe(false);
  });

  test("an empty account is known-empty, not unknown", async () => {
    const result = await readAccountMemories(ok([]));
    expect(result).toEqual({ known: true, entries: [] });
  });
});

describe("snapshotContains", () => {
  test("matches despite whitespace and case differences", () => {
    const snapshot = { known: true as const, entries: ["  Prefers   SMALL diffs "] };
    expect(snapshotContains(snapshot, "prefers small diffs")).toBe(true);
  });

  test("matches when Saved Memory reworded the entry around the original", () => {
    // ChatGPT commonly stores a longer sentence that embeds what was asked for.
    const snapshot = { known: true as const, entries: ["User prefers small diffs with tests."] };
    expect(snapshotContains(snapshot, "prefers small diffs")).toBe(true);
  });

  test("does not match unrelated entries", () => {
    const snapshot = { known: true as const, entries: ["likes tea"] };
    expect(snapshotContains(snapshot, "prefers small diffs")).toBe(false);
  });
});

describe("verifyAccountMemoryWrite", () => {
  test("verified when the entry is present", async () => {
    expect(await verifyAccountMemoryWrite(ok(["deploys need two approvals"]), "deploys need two approvals"))
      .toEqual({ verified: true });
  });

  test("conclusively unverified when the account is readable and lacks it", async () => {
    // The live false positive: ChatGPT confirmed a save the account never took.
    expect(await verifyAccountMemoryWrite(ok(["something else"]), "delete me"))
      .toEqual({ verified: false, conclusive: true });
  });

  test("inconclusive when the account cannot be read", async () => {
    const result = await verifyAccountMemoryWrite(page(new Error("no session")), "anything");
    expect(result).toMatchObject({ verified: false, conclusive: false });
  });
});
