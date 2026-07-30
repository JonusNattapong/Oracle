import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProfileStore } from "./profile.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-awareness-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ProfileStore awareness", () => {
  test("derives a bounded default self-awareness snapshot", async () => {
    const store = new ProfileStore(root);
    const snapshot = await store.getAwareness({
      workspaceRoot: path.join(root, "workspace"),
      interface: "mcp",
      backend: "codex"
    });

    expect(snapshot.self).toMatchObject({
      name: "Oracle",
      role: expect.stringContaining("coordination")
    });
    expect(snapshot.operator).toBeNull();
    expect(snapshot.environment).toMatchObject({
      workspaceRoot: path.resolve(root, "workspace"),
      interface: "mcp",
      backend: "codex"
    });
    expect(snapshot.capabilities).toEqual(expect.arrayContaining([
      expect.stringContaining("project and global memory")
    ]));
    expect(snapshot.boundaries).toEqual(expect.arrayContaining([
      expect.stringContaining("must not be claimed"),
      expect.stringContaining("not a conscious being")
    ]));
  });

  test("renders persisted persona and operator context without losing boundaries", async () => {
    const store = new ProfileStore(root);
    await store.saveIdentity({
      name: "Nattapong",
      role: "maintainer",
      preferences: ["concise evidence"],
      goals: ["ship safely"]
    });
    await store.savePersona({
      name: "Oracle",
      tone: "friendly",
      style: "Direct and reflective."
    });

    const context = await store.buildAwarenessContext({
      workspaceRoot: root,
      interface: "agent",
      backend: "anthropic",
      readOnly: true
    });

    expect(context).toContain("Identity: Oracle.");
    expect(context).toContain("Operator: Nattapong (maintainer).");
    expect(context).toContain("Operator preferences: concise evidence.");
    expect(context).toContain("Operator goals: ship safely.");
    expect(context).toContain("Current interface: agent.");
    expect(context).toContain("Current execution backend: anthropic.");
    expect(context).toContain("Read-only mode: enabled.");
    expect(context).toContain("Analyze workspace state without mutation");
    expect(context).not.toContain("Manage memory, documentation, identity");
    expect(context).toContain("Boundaries:");
  });

  test("treats a cleared empty identity as no configured operator", async () => {
    const store = new ProfileStore(root);
    await store.saveIdentity({ name: "" });
    const snapshot = await store.getAwareness({
      workspaceRoot: root,
      interface: "cli"
    });
    expect(snapshot.operator).toBeNull();
  });
});
