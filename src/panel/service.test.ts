import { describe, expect, test, vi } from "vitest";
import { OracleError } from "../errors.js";
import type { ConsultResult } from "../types.js";
import {
  DEFAULT_PANEL_CONCURRENCY,
  formatPanelManifest,
  parsePanelMember,
  parsePanelMembers,
  runPanel
} from "./service.js";
import type { PanelMember } from "./types.js";

const BACKENDS = ["anthropic", "openai", "gemini", "codex"];
const parseBackend = (value: string): string => {
  if (!BACKENDS.includes(value)) throw new Error(`Unknown backend: ${value}.`);
  return value;
};

function completed(overrides: Partial<ConsultResult> = {}): ConsultResult {
  return {
    sessionId: "session-1",
    status: "completed",
    model: "m",
    files: [],
    output: "an answer",
    usage: { inputTokens: 10, outputTokens: 20 },
    ...overrides
  };
}

function errored(message: string): ConsultResult {
  return {
    sessionId: "session-err",
    status: "error",
    model: "m",
    files: [],
    output: "",
    usage: {},
    error: message
  };
}

describe("panel member specs", () => {
  test("accepts backend, backend:model, and labelled forms", () => {
    expect(parsePanelMember("anthropic", parseBackend)).toEqual({
      id: "anthropic",
      backend: "anthropic"
    });
    expect(parsePanelMember("anthropic:claude-3-sonnet", parseBackend)).toEqual({
      id: "anthropic:claude-3-sonnet",
      backend: "anthropic",
      model: "claude-3-sonnet"
    });
    expect(parsePanelMember("reviewer=anthropic:claude-3-sonnet", parseBackend)).toEqual({
      id: "reviewer",
      backend: "anthropic",
      model: "claude-3-sonnet"
    });
    expect(parsePanelMember("  second = gemini  ", parseBackend)).toEqual({
      id: "second",
      backend: "gemini"
    });
  });

  test("rejects malformed specs", () => {
    for (const spec of ["", "   ", "=anthropic", "anthropic:", "reviewer="]) {
      expect(() => parsePanelMember(spec, parseBackend)).toThrow(OracleError);
    }
  });

  test("rejects an unknown backend through the injected parser", () => {
    expect(() => parsePanelMember("nope:model", parseBackend)).toThrow(/Unknown backend/);
  });

  test("rejects duplicate seats instead of silently collapsing them", () => {
    expect(() => parsePanelMembers(["anthropic", "anthropic"], parseBackend)).toThrow(
      /Duplicate panel member/
    );
    // Distinct labels make the same backend twice legitimate.
    expect(
      parsePanelMembers(["first=anthropic", "second=anthropic"], parseBackend)
    ).toHaveLength(2);
  });

  test("requires at least one member", () => {
    expect(() => parsePanelMembers([], parseBackend)).toThrow(/at least one member/);
  });
});

describe("runPanel", () => {
  const members: PanelMember[] = [
    { id: "a", backend: "anthropic", model: "m1" },
    { id: "b", backend: "openai", model: "m2" },
    { id: "c", backend: "gemini" }
  ];
  const base = { prompt: "should we ship?", cwd: "/work", members };

  test("reports complete when every member answers", async () => {
    const manifest = await runPanel(base, async () => completed());
    expect(manifest.status).toBe("complete");
    expect(manifest.succeeded).toBe(3);
    expect(manifest.failed).toBe(0);
    expect(manifest.requested).toBe(3);
  });

  test("one failure yields a partial manifest, not a failed panel", async () => {
    const manifest = await runPanel(base, async (member) =>
      member.id === "b" ? errored("rate limited") : completed()
    );
    expect(manifest.status).toBe("partial");
    expect(manifest.succeeded).toBe(2);
    expect(manifest.failed).toBe(1);
    const failed = manifest.members.find((m) => m.id === "b")!;
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("rate limited");
    expect(failed.output).toBeUndefined();
  });

  test("a thrown error is recorded, and the other members still run", async () => {
    const run = vi.fn(async (member: PanelMember) => {
      if (member.id === "a") throw new Error("boom");
      return completed();
    });
    const manifest = await runPanel(base, run);
    expect(run).toHaveBeenCalledTimes(3);
    expect(manifest.status).toBe("partial");
    expect(manifest.members.find((m) => m.id === "a")!.error).toBe("boom");
    expect(manifest.members.filter((m) => m.status === "completed")).toHaveLength(2);
  });

  test("reports failed only when nobody answers", async () => {
    const manifest = await runPanel(base, async () => errored("down"));
    expect(manifest.status).toBe("failed");
    expect(manifest.succeeded).toBe(0);
    expect(manifest.failed).toBe(3);
  });

  test("an error record with no message still gets a readable one", async () => {
    const manifest = await runPanel(
      { ...base, members: [members[0]!] },
      async () => ({ ...errored("x"), error: undefined })
    );
    expect(manifest.members[0]!.error).toMatch(/no message/);
  });

  test("results keep member order regardless of completion order", async () => {
    const manifest = await runPanel(base, async (member) => {
      const delay = member.id === "a" ? 30 : member.id === "b" ? 10 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return completed({ output: member.id });
    });
    expect(manifest.members.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(manifest.members.map((m) => m.output)).toEqual(["a", "b", "c"]);
  });

  test("honours the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const many: PanelMember[] = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      backend: "anthropic"
    }));
    await runPanel({ ...base, members: many, concurrency: 2 }, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return completed();
    });
    expect(peak).toBe(2);
  });

  test("never starts more workers than there are members", async () => {
    let peak = 0;
    let active = 0;
    await runPanel(
      { ...base, members: [members[0]!], concurrency: DEFAULT_PANEL_CONCURRENCY },
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        active -= 1;
        return completed();
      }
    );
    expect(peak).toBe(1);
  });

  test("runs each member exactly once", async () => {
    const seen: string[] = [];
    await runPanel(base, async (member) => {
      seen.push(member.id);
      return completed();
    });
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
  });

  test("carries prompt, cwd, and timing into the manifest", async () => {
    let tick = 0;
    const manifest = await runPanel(
      { ...base, now: () => new Date("2026-07-31T00:00:00.000Z"), elapsed: () => (tick += 5) },
      async () => completed()
    );
    expect(manifest.prompt).toBe("should we ship?");
    expect(manifest.cwd).toBe("/work");
    expect(manifest.version).toBe(1);
    expect(manifest.createdAt).toBe("2026-07-31T00:00:00.000Z");
    expect(manifest.id).toMatch(/^panel-20260731000000-[0-9a-f]{8}$/);
    expect(manifest.durationMs).toBeGreaterThan(0);
  });

  test("rejects an empty panel", async () => {
    await expect(runPanel({ ...base, members: [] }, async () => completed())).rejects.toThrow(
      /at least one member/
    );
  });
});

describe("formatPanelManifest", () => {
  const members: PanelMember[] = [
    { id: "a", backend: "anthropic", model: "m1" },
    { id: "b", backend: "openai", model: "m2" }
  ];

  test("prints each answer and a separate failure section", async () => {
    const manifest = await runPanel(
      { prompt: "q", cwd: "/work", members },
      async (member) => (member.id === "b" ? errored("rate limited") : completed({ output: "ship it" }))
    );
    const report = formatPanelManifest(manifest);
    expect(report).toContain("1 of 2 members answered; 1 failed.");
    expect(report).toContain("## a (anthropic:m1)");
    expect(report).toContain("ship it");
    expect(report).toContain("## Did not answer");
    expect(report).toContain("- b (openai:m2): rate limited");
  });

  test("omits the failure section when everyone answered", async () => {
    const manifest = await runPanel({ prompt: "q", cwd: "/work", members }, async () => completed());
    const report = formatPanelManifest(manifest);
    expect(report).toContain("All 2 members answered.");
    expect(report).not.toContain("Did not answer");
  });

  test("a total failure still names every member and reason", async () => {
    const manifest = await runPanel({ prompt: "q", cwd: "/work", members }, async () =>
      errored("no credentials")
    );
    const report = formatPanelManifest(manifest);
    expect(report).toContain("No member answered (2 failed).");
    expect(report).toContain("- a (anthropic:m1): no credentials");
    expect(report).toContain("- b (openai:m2): no credentials");
  });
});
