import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OracleError } from "../errors.js";
import { PanelStore, panelManifestPath, panelsDir } from "./store.js";
import { PANEL_MANIFEST_VERSION, type PanelManifest } from "./types.js";

function manifest(overrides: Partial<PanelManifest> = {}): PanelManifest {
  return {
    version: PANEL_MANIFEST_VERSION,
    id: "panel-20260731000000-abcdef01",
    createdAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:00:05.000Z",
    durationMs: 5_000,
    prompt: "should we ship?",
    cwd: "/work",
    status: "partial",
    requested: 2,
    succeeded: 1,
    failed: 1,
    members: [
      {
        id: "a",
        backend: "anthropic",
        status: "completed",
        output: "ship it",
        durationMs: 100
      },
      { id: "b", backend: "openai", status: "error", error: "rate limited", durationMs: 20 }
    ],
    ...overrides
  };
}

describe("panel store", () => {
  let directory: string;
  let store: PanelStore;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-panel-"));
    store = new PanelStore(directory);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  test("round-trips a manifest under .oracle/panels", async () => {
    const written = await store.write(manifest());
    expect(written).toBe(
      path.join(panelsDir(directory), "panel-20260731000000-abcdef01.json")
    );
    await expect(store.read("panel-20260731000000-abcdef01")).resolves.toEqual(manifest());
  });

  test("leaves no temp file behind", async () => {
    await store.write(manifest());
    await expect(fs.readdir(panelsDir(directory))).resolves.toEqual([
      "panel-20260731000000-abcdef01.json"
    ]);
  });

  test("lists newest first and honours the limit", async () => {
    await store.write(manifest({ id: "panel-a", createdAt: "2026-07-29T00:00:00.000Z" }));
    await store.write(manifest({ id: "panel-b", createdAt: "2026-07-31T00:00:00.000Z" }));
    await store.write(manifest({ id: "panel-c", createdAt: "2026-07-30T00:00:00.000Z" }));

    await expect(store.list()).resolves.toMatchObject([
      { id: "panel-b" },
      { id: "panel-c" },
      { id: "panel-a" }
    ]);
    await expect(store.list(2)).resolves.toHaveLength(2);
  });

  test("listing an absent directory is empty, not an error", async () => {
    await expect(new PanelStore(path.join(directory, "nothing")).list()).resolves.toEqual([]);
  });

  test("a corrupt manifest is skipped rather than breaking the listing", async () => {
    await store.write(manifest({ id: "panel-good" }));
    await fs.writeFile(path.join(panelsDir(directory), "panel-bad.json"), "{oops", "utf8");
    await expect(store.list()).resolves.toMatchObject([{ id: "panel-good" }]);
  });

  test("reading a missing manifest points at the list command", async () => {
    await expect(store.read("panel-absent")).rejects.toThrow(/No panel manifest/);
    await expect(store.read("panel-absent")).rejects.toMatchObject({
      code: "ORACLE_SESSION_NOT_FOUND",
      suggestion: expect.stringContaining("oracle panel list")
    });
  });

  test("rejects a manifest version this build does not write", async () => {
    await store.write(manifest({ id: "panel-future" }));
    const filePath = panelManifestPath(directory, "panel-future");
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as PanelManifest;
    await fs.writeFile(filePath, JSON.stringify({ ...raw, version: 99 }), "utf8");
    await expect(store.read("panel-future")).rejects.toThrow(/unsupported version 99/);
  });

  test("rejects an id that would escape the panels directory", () => {
    for (const id of ["../escape", "a/b", "..", ".hidden", "with space", ""]) {
      expect(() => panelManifestPath(directory, id)).toThrow(OracleError);
    }
  });
});
