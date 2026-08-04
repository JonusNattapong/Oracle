import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listDocs, searchDocs, addDoc, removeDoc, docsDir } from "./reader.js";

describe("docs reader", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-docs-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("addDoc creates the file and listDocs finds it", async () => {
    await addDoc(tmp, "guide.md", "# Guide\nhello world");
    const docs = await listDocs(tmp);
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("guide.md");
  });

  it("addDoc rejects disallowed extensions", async () => {
    await expect(addDoc(tmp, "script.sh", "echo hi")).rejects.toThrow();
  });

  it("addDoc rejects path traversal", async () => {
    await expect(addDoc(tmp, "../../etc/passwd", "x")).rejects.toThrow();
  });

  it("addDoc creates nested directories", async () => {
    await addDoc(tmp, "auth/oauth.md", "# OAuth\ndetails");
    const docs = await listDocs(tmp);
    expect(docs[0].name).toBe(path.join("auth", "oauth.md"));
  });

  it("removeDoc deletes an existing file and returns true", async () => {
    await addDoc(tmp, "guide.md", "content");
    expect(await removeDoc(tmp, "guide.md")).toBe(true);
    expect(await listDocs(tmp)).toHaveLength(0);
  });

  it("removeDoc returns false for a missing file", async () => {
    expect(await removeDoc(tmp, "missing.md")).toBe(false);
  });

  it("searchDocs ranks the more relevant chunk first, across files", async () => {
    await addDoc(tmp, "redis.md", "# Redis\nConnection pool exhausted under high load.");
    await addDoc(tmp, "postgres.md", "# Postgres\nMigration lock contention on deploy.");
    const results = await searchDocs(tmp, "redis connection pool");
    expect(results[0].name).toBe("redis.md");
    expect(results[0].heading).toBe("Redis");
  });

  it("searchDocs reuses the cached index on a second call for unchanged files", async () => {
    await addDoc(tmp, "a.md", "# A\nsome content about caching");
    const first = await searchDocs(tmp, "caching");
    const indexRaw = await fs.readFile(path.join(docsDir(tmp), ".index.json"), "utf8");
    expect(JSON.parse(indexRaw).files).toHaveLength(1);
    const second = await searchDocs(tmp, "caching");
    expect(second).toEqual(first);
  });

  it("searchDocs reflects an addDoc after a prior search invalidated the cache", async () => {
    await addDoc(tmp, "a.md", "# A\nzzzzunique term one");
    await searchDocs(tmp, "zzzzunique");
    await addDoc(tmp, "b.md", "# B\nzzzzunique term two");
    const results = await searchDocs(tmp, "zzzzunique");
    expect(results.map((r) => r.name).sort()).toEqual(["a.md", "b.md"]);
  });

  it("searchDocs returns [] when .oracle/docs/ doesn't exist", async () => {
    expect(await searchDocs(tmp, "anything")).toEqual([]);
  });
});
