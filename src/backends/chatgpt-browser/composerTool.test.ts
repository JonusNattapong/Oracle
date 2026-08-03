import { describe, expect, test } from "vitest";
import { ResponseMonitor, type CdpClient } from "./response.js";

interface Recorded {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Stub page. `activeAfterClicks` is how many menu clicks it takes before the
 * composer reports the tool as on — 0 means it was already on, Infinity means it
 * never engages.
 */
function fakeSession(options: { activeAfterClicks: number; hasPlus?: boolean; hasItem?: boolean }) {
  const calls: Recorded[] = [];
  let clicks = 0;
  const session: CdpClient = {
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") clicks++;
      return undefined as T;
    },
    async evaluate<T>(expression: string): Promise<T> {
      // Composer readiness and the active check both read the form's text.
      if (expression.includes("form.innerText") || expression.includes("form && form.innerText")) {
        if (expression.includes("includes(")) {
          return (clicks >= options.activeAfterClicks) as unknown as T;
        }
        return true as unknown as T; // composer rendered
      }
      if (expression.includes("getBoundingClientRect")) {
        const wantsItem = expression.includes("textContent");
        if (wantsItem && options.hasItem === false) return null as unknown as T;
        if (!wantsItem && options.hasPlus === false) return null as unknown as T;
        return { x: 100, y: 200 } as unknown as T;
      }
      return null as unknown as T;
    },
    async evaluateAsync<T>(): Promise<T> {
      return undefined as T;
    }
  };
  return { session, calls, clickCount: () => clicks };
}

describe("selectComposerTool", () => {
  test("does nothing when the tool is already on", async () => {
    const { session, calls } = fakeSession({ activeAfterClicks: 0 });
    const monitor = new ResponseMonitor(session);

    await expect(monitor.selectComposerTool("Web search")).resolves.toBe(true);
    // Re-selecting an active tool stacks a second pill onto the composer.
    expect(calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  test("opens the menu and confirms the tool engaged", async () => {
    const { session, clickCount } = fakeSession({ activeAfterClicks: 2 });
    const monitor = new ResponseMonitor(session);

    await expect(monitor.selectComposerTool("Web search")).resolves.toBe(true);
    // The plus button, then the menu entry.
    expect(clickCount()).toBe(2);
  });

  test("reports failure when the tool never engages", async () => {
    const { session } = fakeSession({ activeAfterClicks: Number.POSITIVE_INFINITY });
    const monitor = new ResponseMonitor(session);

    // Clicking the entry is not evidence it took effect; answering as though the
    // web had been searched when it had not is worse than failing.
    await expect(monitor.selectComposerTool("Web search", 1_500)).resolves.toBe(false);
  });

  test("reports failure when the composer menu has no such entry", async () => {
    const { session } = fakeSession({
      activeAfterClicks: Number.POSITIVE_INFINITY,
      hasItem: false
    });
    const monitor = new ResponseMonitor(session);

    await expect(monitor.selectComposerTool("Web search", 1_500)).resolves.toBe(false);
  });

  test("reports failure when the composer has no plus button", async () => {
    const { session } = fakeSession({
      activeAfterClicks: Number.POSITIVE_INFINITY,
      hasPlus: false
    });
    const monitor = new ResponseMonitor(session);

    await expect(monitor.selectComposerTool("Web search", 1_500)).resolves.toBe(false);
  });
});
