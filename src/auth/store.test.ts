import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TokenStore } from "./store.js";

describe("TokenStore", () => {
  let home: string;
  let store: TokenStore;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-auth-"));
    store = new TokenStore(home);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  test("round-trips a token entry", async () => {
    await store.write("anthropic", {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 123,
      planTier: "max",
    });
    expect(await store.read("anthropic")).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 123,
      planTier: "max",
    });
  });

  test("reading an absent provider returns null rather than throwing", async () => {
    expect(await store.read("nobody")).toBeNull();
  });

  test("corrupt token files read as null instead of crashing the CLI", async () => {
    const file = path.join(home, "auth", "anthropic.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json", "utf8");
    expect(await store.read("anthropic")).toBeNull();
  });

  test("writes the token file owner-only", async () => {
    await store.write("anthropic", { accessToken: "secret" });
    const stat = await fs.stat(path.join(home, "auth", "anthropic.json"));
    if (os.platform() === "win32") return; // Windows has no POSIX mode bits
    // These are long-lived credentials; group/other must not be able to read them.
    expect(stat.mode & 0o077).toBe(0);
  });

  test("overwriting an existing token keeps it owner-only", async () => {
    await store.write("anthropic", { accessToken: "first" });
    await store.write("anthropic", { accessToken: "second" });
    const file = path.join(home, "auth", "anthropic.json");
    expect((await store.read("anthropic"))?.accessToken).toBe("second");
    if (os.platform() === "win32") return;
    expect((await fs.stat(file)).mode & 0o077).toBe(0);
  });

  test("leaves no temp file behind after a write", async () => {
    await store.write("anthropic", { accessToken: "at" });
    const entries = await fs.readdir(path.join(home, "auth"));
    expect(entries).toEqual(["anthropic.json"]);
  });

  test("delete removes the session and is safe to call twice", async () => {
    await store.write("anthropic", { accessToken: "at" });
    await store.delete("anthropic");
    expect(await store.read("anthropic")).toBeNull();
    await expect(store.delete("anthropic")).resolves.toBeUndefined();
  });

  test("providers are stored independently", async () => {
    await store.write("anthropic", { accessToken: "a" });
    await store.write("other", { accessToken: "b" });
    await store.delete("anthropic");
    expect(await store.read("other")).toEqual({ accessToken: "b" });
  });
});
