import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { discoverSources, searchHistory } from "./scan.js";

let home: string;

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-hist-"));

  // Claude Code layout: ~/.claude/projects/<slug>/<session>.jsonl
  const claude = path.join(home, ".claude", "projects", "D--proj");
  await fs.mkdir(claude, { recursive: true });
  await fs.writeFile(
    path.join(claude, "sess1.jsonl"),
    jsonl([
      { type: "queue-operation", timestamp: "2026-07-22T07:00:00Z" }, // non-chat line — skipped
      { type: "user", timestamp: "2026-07-22T08:00:00Z", message: { role: "user", content: "please add dark mode" } },
      { type: "assistant", timestamp: "2026-07-22T08:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "adding the dark mode toggle now" }] } }
    ])
  );

  // Unknown-but-conventional tool: ~/.newtool/sessions/a.jsonl (pattern discovery, no hardcoding)
  const newtool = path.join(home, ".newtool", "sessions");
  await fs.mkdir(newtool, { recursive: true });
  await fs.writeFile(
    path.join(newtool, "a.jsonl"),
    jsonl([{ role: "user", content: "deploy the health endpoint", timestamp: "2026-07-21T10:00:00Z" }])
  );

  // Junk that must be ignored: fixtures under .tmp
  const junk = path.join(home, ".codex", ".tmp", "fixtures");
  await fs.mkdir(junk, { recursive: true });
  await fs.writeFile(path.join(junk, "responses.jsonl"), jsonl([{ role: "user", content: "junk" }]));

  // Non-chat dot-dir: sniff must reject it
  const ssh = path.join(home, ".ssh", "sessions");
  await fs.mkdir(ssh, { recursive: true });
  await fs.writeFile(path.join(ssh, "known.jsonl"), "not json at all\n");
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("history discovery", () => {
  test("finds tools by layout pattern, rejects junk and non-chat files", async () => {
    const sources = await discoverSources(home);
    const tools = sources.map((s) => s.tool).sort();
    expect(tools).toContain("claude");
    expect(tools).toContain("newtool"); // never hardcoded anywhere
    expect(tools).not.toContain("ssh");
    expect(tools).not.toContain("codex"); // only had .tmp junk
  });
});

describe("history search", () => {
  test("time window is primary: since excludes older entries", async () => {
    const hits = await searchHistory({ home, since: "2026-07-22" });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.tool === "claude")).toBe(true);
    expect(hits[0].ts! >= hits[1].ts!).toBe(true); // newest first
  });

  test("query narrows within the window; tool filter works", async () => {
    const hits = await searchHistory({ home, query: "dark mode" });
    expect(hits.length).toBe(2);
    const one = await searchHistory({ home, query: "dark mode", tool: "newtool" });
    expect(one.length).toBe(0);
  });

  test("array content blocks are flattened to text", async () => {
    const hits = await searchHistory({ home, query: "toggle" });
    expect(hits.length).toBe(1);
    expect(hits[0].role).toBe("assistant");
    expect(hits[0].text).toContain("dark mode toggle");
  });
});
