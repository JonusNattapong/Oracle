import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ACCOUNT_MEMORY_LIST_BEGIN,
  ACCOUNT_MEMORY_LIST_END,
  ACCOUNT_MEMORY_FORGOTTEN_MARKER,
  ACCOUNT_MEMORY_EMPTY_MARKER,
  buildAccountMemoryRecallPrompt,
  parseAccountMemoryRecall
} from "../backends/chatgpt-browser/accountMemory.js";
import type {
  ExecutionBackend,
  ExecutionBackendRequest,
  ExecutionBackendResponse
} from "../backends/backend.js";
import { loadProjectConfig } from "../config/project.js";
import { MemoryAdapter } from "./adapter.js";
import { ChatGptMemoryAdapter } from "./chatgptMemoryAdapter.js";
import { HybridMemoryAdapter, shouldMirror, type MirrorOutcome } from "./hybridMemoryAdapter.js";

/** Scriptable stand-in for the chatgpt-browser backend. */
class FakeChatGptBackend implements ExecutionBackend {
  readonly id = "chatgpt-browser";
  readonly capabilities = {
    consult: true,
    toolUse: false,
    images: false,
    continuation: true,
    accountMemory: true,
    structuredUsage: false,
    supportedPlatforms: ["win32", "darwin", "linux"] as const
  };
  readonly requests: ExecutionBackendRequest[] = [];
  /** Saved Memory contents this fake account holds. */
  saved: string[] = [];
  /** When set, the next run() rejects with this error. */
  failWith: Error | null = null;
  /** When true, saves are acknowledged but never confirmed. */
  refuseSave = false;
  /** When true, the account declines to enumerate Saved Memory. */
  refuseRead = false;
  /** When true, ChatGPT claims the save but the account cannot be checked. */
  unverifiableSave = false;
  /** When true, the account listing is unavailable, so nothing can be verified. */
  unlistable = false;
  /** When true, the delete is claimed but the entry is left in place. */
  ignoreDeletes = false;

  async listAccountMemories() {
    return this.unlistable
      ? { known: false as const, reason: "listing unavailable" }
      : { known: true as const, entries: [...this.saved] };
  }

  async run(request: ExecutionBackendRequest): Promise<ExecutionBackendResponse> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    if (request.userPrompt.includes(ACCOUNT_MEMORY_LIST_BEGIN)) {
      // Matches the real protocol: emptiness is stated with the marker, never
      // with an empty array.
      if (this.refuseRead) return { text: "I can't share that.", usage };
      return {
        text: this.saved.length
          ? [
              ACCOUNT_MEMORY_LIST_BEGIN,
              JSON.stringify(this.saved),
              ACCOUNT_MEMORY_LIST_END
            ].join("\n")
          : ACCOUNT_MEMORY_EMPTY_MARKER,
        usage
      };
    }
    if (request.userPrompt.includes("delete one entry")) {
      const match = request.userPrompt.match(/Memory text: (".*")/);
      if (match && !this.ignoreDeletes) {
        const target = JSON.parse(match[1]) as string;
        this.saved = this.saved.filter((entry) => entry !== target);
      }
      // The marker is emitted either way: that is exactly the failure being
      // guarded against.
      return { text: ACCOUNT_MEMORY_FORGOTTEN_MARKER, usage };
    }
    if (request.accountMemory) {
      // Mirrors the real backend: it drives the save itself, throws when ChatGPT
      // does not confirm, and reports the outcome via accountMemorySaved — the
      // caller's userPrompt is a separate, ordinary turn.
      if (this.refuseSave) {
        throw new Error("ChatGPT did not confirm the Saved Memory update");
      }
      if (this.unverifiableSave) {
        // ChatGPT claimed the save, but the account could not be inspected.
        return { text: "OK", usage, accountMemorySaved: false, accountMemoryVerification: "unverified" };
      }
      this.saved.push(request.accountMemory);
      return { text: "OK", usage, accountMemorySaved: true, accountMemoryVerification: "verified" };
    }
    return { text: "", usage };
  }

  async healthCheck() {
    return [];
  }
}

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-memory-store-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("memory store configuration", () => {
  test("defaults to local storage", async () => {
    const config = await loadProjectConfig(workspace);
    expect(config.memory.store).toBe("local");
    expect(config.memory.mirror.types).toEqual(["fact", "insight"]);
  });

  test("reads store and mirror policy from .oracle/config.json", async () => {
    await fs.mkdir(path.join(workspace, ".oracle"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".oracle", "config.json"),
      JSON.stringify({
        memory: { store: "hybrid", mirror: { minImportance: 0.9, types: ["insight"] } }
      }),
      "utf8"
    );
    const config = await loadProjectConfig(workspace);
    expect(config.memory.store).toBe("hybrid");
    expect(config.memory.mirror.minImportance).toBe(0.9);
    expect(config.memory.mirror.types).toEqual(["insight"]);
    // Unspecified keys still fall back to defaults.
    expect(config.memory.remoteBackend).toBe("chatgpt-browser");
  });

  test("rejects an unknown store", async () => {
    await fs.mkdir(path.join(workspace, ".oracle"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".oracle", "config.json"),
      JSON.stringify({ memory: { store: "dropbox" } }),
      "utf8"
    );
    await expect(loadProjectConfig(workspace)).rejects.toThrow(/invalid/i);
  });
});

describe("account memory recall protocol", () => {
  test("parses the JSON block between markers", () => {
    const response = [
      "Sure, here they are.",
      ACCOUNT_MEMORY_LIST_BEGIN,
      '["prefers small diffs", "works on Oracle"]',
      ACCOUNT_MEMORY_LIST_END
    ].join("\n");
    expect(parseAccountMemoryRecall(response)).toEqual({
      readable: true,
      entries: ["prefers small diffs", "works on Oracle"]
    });
  });

  test("accepts emptiness only from the explicit marker", () => {
    expect(parseAccountMemoryRecall(ACCOUNT_MEMORY_EMPTY_MARKER)).toEqual({
      readable: true,
      entries: []
    });
  });

  test("treats a bare empty array as unreadable, not as an empty account", () => {
    // Observed live: ChatGPT answered `[]` while four memories were present.
    // Accepting that as emptiness silently hides real stored data.
    const result = parseAccountMemoryRecall(
      `${ACCOUNT_MEMORY_LIST_BEGIN}\n[]\n${ACCOUNT_MEMORY_LIST_END}`
    );
    expect(result.readable).toBe(false);
  });

  test("reports malformed or missing blocks as unreadable", () => {
    expect(parseAccountMemoryRecall("no markers here").readable).toBe(false);
    expect(
      parseAccountMemoryRecall(`${ACCOUNT_MEMORY_LIST_BEGIN}\nnot json\n${ACCOUNT_MEMORY_LIST_END}`)
        .readable
    ).toBe(false);
  });

  test("does not accept the empty marker alongside a malformed list", () => {
    const result = parseAccountMemoryRecall(
      `${ACCOUNT_MEMORY_EMPTY_MARKER}\n${ACCOUNT_MEMORY_LIST_BEGIN}\nnot json\n${ACCOUNT_MEMORY_LIST_END}`
    );
    expect(result.readable).toBe(false);
  });

  test("instructs the model never to answer with an empty array", () => {
    expect(buildAccountMemoryRecallPrompt()).toContain("Never answer with an empty array");
  });

  test("passes the query through as a hint", () => {
    expect(buildAccountMemoryRecallPrompt("deploy process")).toContain("deploy process");
  });
});

describe("ChatGptMemoryAdapter", () => {
  test("writes durable memory to the account and reads it back", async () => {
    const backend = new FakeChatGptBackend();
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cacheTtlMinutes: 0,
      cwd: workspace
    });

    await adapter.remember("oracle", "fact", "Deploys run on Fridays");
    expect(backend.saved).toContain("Deploys run on Fridays");

    const recalled = await adapter.recall();
    expect(recalled.map((entry) => entry.content)).toContain("Deploys run on Fridays");
  });

  test("saves once per remember, not twice", async () => {
    // The backend builds its own memory prompt from `accountMemory` and sends
    // `userPrompt` as a separate ordinary turn. Passing the memory request as
    // the prompt too would save the entry a second time.
    const backend = new FakeChatGptBackend();
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cacheTtlMinutes: 0,
      cwd: workspace
    });

    await adapter.remember("oracle", "fact", "Exactly one copy");

    expect(backend.saved).toEqual(["Exactly one copy"]);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0].userPrompt).not.toContain("Saved Memory");
  });

  test("surfaces entries saved directly in ChatGPT that Oracle never wrote", async () => {
    const backend = new FakeChatGptBackend();
    backend.saved = ["Set from the ChatGPT web UI"];
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cacheTtlMinutes: 0,
      cwd: workspace
    });

    const recalled = await adapter.recall();
    const remoteOnly = recalled.find((entry) => entry.content === "Set from the ChatGPT web UI");
    expect(remoteOnly).toBeDefined();
    expect(remoteOnly?.id.startsWith("chatgpt:")).toBe(true);
  });

  test("fails the write when ChatGPT does not confirm the save", async () => {
    const backend = new FakeChatGptBackend();
    backend.refuseSave = true;
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cwd: workspace
    });

    await expect(adapter.remember("oracle", "fact", "Never lands")).rejects.toThrow(
      /did not confirm/i
    );
    expect(backend.saved).toEqual([]);
    // Nothing may be shadow-indexed if the remote write failed.
    const local = await new MemoryAdapter(workspace).recall({ limit: 10 });
    expect(local.map((entry) => entry.content)).not.toContain("Never lands");
  });

  test("keeps working memory local and off the account surface", async () => {
    const backend = new FakeChatGptBackend();
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cwd: workspace
    });

    await adapter.remember("oracle", "working", "scratch note");
    expect(backend.saved).toEqual([]);
    expect(backend.requests).toHaveLength(0);
  });

  test("rejects entries beyond the Saved Memory size cap", async () => {
    const adapter = new ChatGptMemoryAdapter({
      backend: new FakeChatGptBackend(),
      shadow: new MemoryAdapter(workspace),
      cwd: workspace
    });
    await expect(
      adapter.remember("oracle", "fact", "x".repeat(2_001))
    ).rejects.toThrow(/2000 characters/);
  });

  test("deletes from the account before dropping the local shadow", async () => {
    const backend = new FakeChatGptBackend();
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cacheTtlMinutes: 0,
      cwd: workspace
    });

    const entry = await adapter.remember("oracle", "fact", "Temporary fact");
    await adapter.forget(entry.id, "fact");
    expect(backend.saved).not.toContain("Temporary fact");
  });

  test("errors instead of reporting an empty memory when the account is unreadable", async () => {
    // The live failure this guards: after a delete, ChatGPT answered with an
    // empty list twice while four memories were still stored. Reporting that as
    // "no memories" hides the account's real contents from every caller.
    const backend = new FakeChatGptBackend();
    backend.saved = ["a real memory that is still there"];
    // Both routes are closed: the account listing is unavailable and ChatGPT
    // declines to enumerate, which is when the conversational fallback runs.
    backend.unlistable = true;
    backend.refuseRead = true;
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cacheTtlMinutes: 0,
      cwd: workspace
    });

    await expect(adapter.recall()).rejects.toThrow(/Could not read ChatGPT Saved Memory/);
  });

  test("reports a genuinely empty account as empty", async () => {
    const backend = new FakeChatGptBackend();
    backend.unlistable = true;
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cacheTtlMinutes: 0,
      cwd: workspace
    });

    await expect(adapter.recall()).resolves.toEqual([]);
  });

  test("rejects a delete the account did not actually perform", async () => {
    // ChatGPT confirms deletions the same way it confirmed saves it never made.
    const backend = new FakeChatGptBackend();
    backend.ignoreDeletes = true;
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cacheTtlMinutes: 0,
      cwd: workspace
    });
    const entry = await adapter.remember("oracle", "fact", "Stubbornly present fact");

    await expect(adapter.forget(entry.id, "fact")).rejects.toThrow(/still present/i);
    // The local copy stays too, so the two stores do not silently diverge.
    const local = await new MemoryAdapter(workspace).recall({ limit: 10 });
    expect(local.map((e) => e.content)).toContain("Stubbornly present fact");
  });

  test("reports an unverifiable delete rather than claiming success", async () => {
    const backend = new FakeChatGptBackend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = new ChatGptMemoryAdapter({
      backend,
      shadow: new MemoryAdapter(workspace),
      cacheTtlMinutes: 0,
      cwd: workspace
    });
    const entry = await adapter.remember("oracle", "fact", "Deleted but unverifiable");
    backend.unlistable = true;

    await adapter.forget(entry.id, "fact");

    expect(warn.mock.calls.some(([m]) => /unverified/i.test(String(m)))).toBe(true);
    warn.mockRestore();
  });

  test("refuses to construct on a backend without account memory", () => {
    const backend = new FakeChatGptBackend();
    const incapable = {
      ...backend,
      capabilities: { ...backend.capabilities, accountMemory: false }
    } as unknown as ExecutionBackend;
    expect(
      () => new ChatGptMemoryAdapter({ backend: incapable, shadow: new MemoryAdapter(workspace) })
    ).toThrow(/cannot write ChatGPT account memory/);
  });
});

describe("mirror policy", () => {
  const policy = { minImportance: 0.7, types: ["fact", "insight"] as const };

  test("mirrors an important fact", () => {
    expect(
      shouldMirror({ ...policy, types: [...policy.types] }, {
        type: "fact",
        content: "Prod deploys need two approvals",
        importance: 0.9
      })
    ).toBe(true);
  });

  test("skips low-importance, wrong-type, and working entries", () => {
    const p = { ...policy, types: [...policy.types] };
    expect(shouldMirror(p, { type: "fact", content: "trivia", importance: 0.2 })).toBe(false);
    expect(shouldMirror(p, { type: "chunk", content: "code", importance: 0.9 })).toBe(false);
    expect(shouldMirror(p, { type: "working", content: "scratch", importance: 1 })).toBe(false);
  });

  test("skips entries too large for Saved Memory", () => {
    expect(
      shouldMirror({ ...policy, types: [...policy.types] }, {
        type: "fact",
        content: "x".repeat(2_001),
        importance: 1
      })
    ).toBe(false);
  });

  test("honours a tag allow-list when configured", () => {
    const tagged = { ...policy, types: [...policy.types], tags: ["shared"] };
    expect(
      shouldMirror(tagged, { type: "fact", content: "a", importance: 1, tags: ["shared"] })
    ).toBe(true);
    expect(
      shouldMirror(tagged, { type: "fact", content: "a", importance: 1, tags: ["private"] })
    ).toBe(false);
  });
});

describe("HybridMemoryAdapter", () => {
  test("writes locally and mirrors entries that clear the policy", async () => {
    const backend = new FakeChatGptBackend();
    const local = new MemoryAdapter(workspace);
    const adapter = new HybridMemoryAdapter({
      local,
      backend,
      mirror: { minImportance: 0.7, types: ["fact", "insight"] },
      cwd: workspace
    });

    await adapter.remember("oracle", "fact", "Release train is weekly", { importance: 0.9 });
    await adapter.remember("oracle", "fact", "Someone likes tea", { importance: 0.1 });

    expect(backend.saved).toEqual(["Release train is weekly"]);
    const stored = await local.recall({ limit: 10 });
    expect(stored.map((entry) => entry.content).sort()).toEqual(
      ["Release train is weekly", "Someone likes tea"].sort()
    );
  });

  test("a failed mirror does not fail or lose the local write", async () => {
    const backend = new FakeChatGptBackend();
    backend.failWith = new Error("chrome profile is locked");
    const local = new MemoryAdapter(workspace);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcomes: Array<{ saved: boolean; reason?: string }> = [];

    const adapter = new HybridMemoryAdapter({
      local,
      backend,
      mirror: { minImportance: 0.5, types: ["fact"] },
      cwd: workspace,
      onMirror: (_entry, outcome) => outcomes.push(outcome)
    });

    const entry = await adapter.remember("oracle", "fact", "Survives the mirror failure", {
      importance: 0.9
    });

    expect(entry.meta.mirrored).toBe(false);
    expect(outcomes).toEqual([
      {
        attempted: true,
        saved: false,
        verification: "not-attempted",
        reason: "chrome profile is locked"
      }
    ]);
    expect(warn).toHaveBeenCalled();
    const stored = await local.recall({ limit: 10 });
    expect(stored.map((e) => e.content)).toContain("Survives the mirror failure");
    warn.mockRestore();
  });

  test("does not claim a mirror that could not be verified", async () => {
    // The live failure this guards: ChatGPT answered ORACLE_MEMORY_SAVED for an
    // entry the account never stored, and hybrid reported mirrored=true. An
    // unverifiable write must read as unverified, never as success.
    const backend = new FakeChatGptBackend();
    backend.unverifiableSave = true;
    const local = new MemoryAdapter(workspace);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcomes: MirrorOutcome[] = [];

    const adapter = new HybridMemoryAdapter({
      local,
      backend,
      mirror: { minImportance: 0.5, types: ["fact"] },
      cwd: workspace,
      onMirror: (_entry, outcome) => outcomes.push(outcome)
    });

    const entry = await adapter.remember("oracle", "fact", "Claimed but unconfirmed", {
      importance: 0.9
    });

    expect(entry.meta.mirrored).toBe(false);
    expect(entry.meta.mirrorVerification).toBe("unverified");
    expect(outcomes[0].verification).toBe("unverified");
    // Scan every call rather than indexing the first: console is global, so a
    // parallel test file can land a warning in between.
    expect(warn.mock.calls.some(([message]) => /unverified/i.test(String(message)))).toBe(true);
    // The local write is untouched either way.
    const stored = await local.recall({ limit: 10 });
    expect(stored.map((e) => e.content)).toContain("Claimed but unconfirmed");
    warn.mockRestore();
  });

  test("marks a verified mirror as mirrored", async () => {
    const backend = new FakeChatGptBackend();
    const adapter = new HybridMemoryAdapter({
      local: new MemoryAdapter(workspace),
      backend,
      mirror: { minImportance: 0.5, types: ["fact"] },
      cwd: workspace
    });

    const entry = await adapter.remember("oracle", "fact", "Confirmed in the account", {
      importance: 0.9
    });

    expect(entry.meta.mirrored).toBe(true);
    expect(entry.meta.mirrorVerification).toBe("verified");
  });

  test("forget removes the local copy and leaves account memory untouched", async () => {
    const backend = new FakeChatGptBackend();
    const local = new MemoryAdapter(workspace);
    const adapter = new HybridMemoryAdapter({
      local,
      backend,
      mirror: { minImportance: 0.5, types: ["fact"] },
      cwd: workspace
    });

    const entry = await adapter.remember("oracle", "fact", "Account-wide preference", {
      importance: 0.9
    });
    await adapter.forget(entry.id, "fact");

    expect(backend.saved).toContain("Account-wide preference");
    const stored = await local.recall({ limit: 10 });
    expect(stored.map((e) => e.content)).not.toContain("Account-wide preference");
  });
});
