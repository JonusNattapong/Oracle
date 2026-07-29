import { describe, expect, test } from "vitest";
import { ChatGptBrowserBackend } from "./backend.js";

describe("ChatGptBrowserBackend", () => {
  test("has expected capabilities contract", () => {
    const backend = new ChatGptBrowserBackend({
      profileDir: "/tmp/fake-profile",
      enabled: true,
      headed: true
    });

    expect(backend.id).toBe("chatgpt-browser");
    expect(backend.capabilities).toEqual({
      consult: true,
      toolUse: false,
      images: true,
      continuation: true,
      accountMemory: true,
      structuredUsage: false,
      supportedPlatforms: ["darwin", "linux", "win32"]
    });
  });

  test("throws ORACLE_BROWSER_MODE_DISABLED if not enabled in config", async () => {
    const backend = new ChatGptBrowserBackend({
      profileDir: "/tmp/fake-profile",
      enabled: false,
      headed: true
    });

    await expect(
      backend.run({
        model: "gpt-5.4",
        systemPrompt: "System",
        userPrompt: "User prompt",
        cwd: "/tmp"
      })
    ).rejects.toMatchObject({
      code: "ORACLE_BROWSER_MODE_DISABLED"
    });
  });

  test("healthCheck returns doctor check array", async () => {
    const backend = new ChatGptBrowserBackend({
      profileDir: "/tmp/fake-profile",
      enabled: false,
      headed: true
    });

    const checks = await backend.healthCheck();
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.some((c) => c.name === "platform")).toBe(true);
    expect(checks.some((c) => c.name === "experimental.browserMode")).toBe(true);
  });
});
