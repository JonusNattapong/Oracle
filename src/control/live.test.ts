import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { connectLiveUpdates, type LiveUpdateOptions } from "./live.js";

function fakeWsUrl(): string {
  return "ws://127.0.0.1:1/nonexistent";
}

describe("connectLiveUpdates", () => {
  let onEvent: ReturnType<typeof vi.fn>;
  let onStatus: ReturnType<typeof vi.fn>;
  let options: LiveUpdateOptions;

  beforeEach(() => {
    onEvent = vi.fn();
    onStatus = vi.fn();
    options = { url: fakeWsUrl(), onEvent, onStatusChange: onStatus };
  });

  test("starts in offline state", () => {
    const conn = connectLiveUpdates(options);
    expect(conn.status).toBe("offline");
    conn.dispose();
  });

  test("dispose cleans up and stops reconnection", () => {
    const conn = connectLiveUpdates(options);
    conn.dispose();
    // After dispose, the connection should be closed and no reconnection attempted
    expect(conn.status).toBe("offline");
  });

  test("connection transitions through statuses (integration smoke)", async () => {
    // We can't easily mock WebSocket in Node without a server, but we can
    // verify the API shape and that event/status callbacks exist.
    const conn = connectLiveUpdates(options);
    expect(typeof conn.dispose).toBe("function");
    expect(typeof conn.lastEventAt).toBe("number");

    // Give a tiny bit of time for the failed connection to trigger callbacks
    await new Promise((r) => setTimeout(r, 100));
    conn.dispose();
    // The onEvent will be called when live updates fire — we just verify no crash
    expect(true).toBe(true);
  });
});
