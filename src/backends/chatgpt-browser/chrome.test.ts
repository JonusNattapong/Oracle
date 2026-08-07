import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { conversationLockKey, withConversationLock, withLaunchLock } from "./chrome.js";

let profileDir: string;

beforeEach(async () => {
  profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-lock-"));
});

afterEach(async () => {
  await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("withLaunchLock", () => {
  test("serializes concurrent holders instead of letting them overlap", async () => {
    // The bug this guards against: two processes both reading "no live Chrome"
    // at the same instant and both deciding to spawn one. Reproducing that
    // requires operations whose bodies can genuinely overlap in time — a
    // synchronous counter increment would never expose interleaving.
    let inFlight = 0;
    let maxObservedConcurrency = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        withLaunchLock(profileDir, async () => {
          inFlight++;
          maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(index);
          inFlight--;
        })
      )
    );

    expect(maxObservedConcurrency).toBe(1);
    expect(order).toHaveLength(8);
  });

  test("propagates the operation's result to its caller", async () => {
    const result = await withLaunchLock(profileDir, async () => "chrome-endpoint");
    expect(result).toBe("chrome-endpoint");
  });

  test("releases the lock even when the operation throws", async () => {
    await expect(
      withLaunchLock(profileDir, async () => {
        throw new Error("spawn failed");
      })
    ).rejects.toThrow("spawn failed");

    // A lock left behind by the failed holder would make this hang until the
    // acquire timeout; resolving quickly is the proof it was released.
    const result = await withLaunchLock(profileDir, async () => "recovered");
    expect(result).toBe("recovered");
  });

  test("recovers a lock abandoned by a crashed holder instead of waiting for it", async () => {
    // Simulates a process that acquired the lock and died without releasing
    // it: the lock file exists but its writer is gone. Backdating the mtime
    // is what `withLaunchLock` reads to tell "abandoned" from "in progress."
    const lockPath = path.join(profileDir, ".launch.lock");
    await fs.writeFile(lockPath, "");
    const staleTime = new Date(Date.now() - 61_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    const start = Date.now();
    const result = await withLaunchLock(profileDir, async () => "recovered-from-stale");
    expect(result).toBe("recovered-from-stale");
    // Recovery must not fall back to the full acquire-timeout wait.
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("withConversationLock", () => {
  const KEY_A = conversationLockKey("https://chatgpt.com/c/aaaa");
  const KEY_B = conversationLockKey("https://chatgpt.com/c/bbbb");

  test("queues concurrent requests to the same conversation", async () => {
    // Reproduces the bug directly: two requests to the SAME thread each read
    // a shared value, mutate it, and write it back — the shape of two
    // windows posting into one ChatGPT conversation at once. Without
    // serialization this loses updates; with it, every request's effect is
    // preserved because none overlaps another's.
    let threadState = 0;
    const seenByEachRequest: number[] = [];

    await Promise.all(
      Array.from({ length: 5 }, () =>
        withConversationLock(profileDir, KEY_A, async () => {
          const observed = threadState;
          await new Promise((resolve) => setTimeout(resolve, 10));
          threadState = observed + 1;
          seenByEachRequest.push(observed);
        })
      )
    );

    expect(threadState).toBe(5);
    // Each request must have observed a distinct prior state; a repeated
    // value would mean two requests read the thread before either wrote back.
    expect(new Set(seenByEachRequest).size).toBe(5);
  });

  test("does not serialize requests to different conversations", async () => {
    // The actual parallelism goal: a different conversation (or, in the
    // caller, a fresh chat with no lock at all) must not queue behind an
    // unrelated one just because they share a Chrome profile.
    let concurrentInA = 0;
    let concurrentInB = 0;
    let maxObservedTotal = 0;

    await Promise.all([
      withConversationLock(profileDir, KEY_A, async () => {
        concurrentInA++;
        maxObservedTotal = Math.max(maxObservedTotal, concurrentInA + concurrentInB);
        await new Promise((resolve) => setTimeout(resolve, 30));
        concurrentInA--;
      }),
      withConversationLock(profileDir, KEY_B, async () => {
        concurrentInB++;
        maxObservedTotal = Math.max(maxObservedTotal, concurrentInA + concurrentInB);
        await new Promise((resolve) => setTimeout(resolve, 30));
        concurrentInB--;
      })
    ]);

    expect(maxObservedTotal).toBe(2);
  });

  test("uses a different lock file than withLaunchLock, so neither blocks the other unnecessarily", async () => {
    let launchRan = false;
    let conversationRan = false;
    await Promise.all([
      withLaunchLock(profileDir, async () => {
        launchRan = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }),
      withConversationLock(profileDir, KEY_A, async () => {
        conversationRan = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      })
    ]);
    expect(launchRan).toBe(true);
    expect(conversationRan).toBe(true);
  });
});

describe("conversationLockKey", () => {
  test("is a stable, filesystem-safe digest", () => {
    const key = conversationLockKey("https://chatgpt.com/c/some-thread-id");
    expect(key).toMatch(/^[a-f0-9]{16}$/);
    expect(conversationLockKey("https://chatgpt.com/c/some-thread-id")).toBe(key);
  });

  test("differs for different conversations", () => {
    expect(conversationLockKey("https://chatgpt.com/c/aaaa"))
      .not.toBe(conversationLockKey("https://chatgpt.com/c/bbbb"));
  });
});
