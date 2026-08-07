import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { withConsultLock, withLaunchLock } from "./chrome.js";

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

describe("withConsultLock", () => {
  test("queues concurrent requests instead of letting them share the tab", async () => {
    // Reproduces the bug directly: three concurrent "requests" each read a
    // shared value, mutate it, and write it back — the exact shape of two
    // callers typing into and reading from the same ChatGPT tab. Without
    // serialization this loses updates; with it, every request's effect is
    // preserved because none overlaps another's.
    let sharedTabState = 0;
    const seenByEachRequest: number[] = [];

    await Promise.all(
      Array.from({ length: 5 }, () =>
        withConsultLock(profileDir, async () => {
          const observed = sharedTabState;
          await new Promise((resolve) => setTimeout(resolve, 10));
          sharedTabState = observed + 1;
          seenByEachRequest.push(observed);
        })
      )
    );

    expect(sharedTabState).toBe(5);
    // Each request must have observed a distinct prior state; a repeated
    // value would mean two requests read the tab before either wrote back.
    expect(new Set(seenByEachRequest).size).toBe(5);
  });

  test("uses a different lock file than withLaunchLock, so neither blocks the other unnecessarily", async () => {
    let launchRan = false;
    let consultRan = false;
    await Promise.all([
      withLaunchLock(profileDir, async () => {
        launchRan = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }),
      withConsultLock(profileDir, async () => {
        consultRan = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      })
    ]);
    expect(launchRan).toBe(true);
    expect(consultRan).toBe(true);
  });
});
