import http from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { ensureWindowNotMinimized } from "./chrome.js";

let server: http.Server | undefined;

/** Serves just enough of the DevTools HTTP API to resolve the browser endpoint. */
async function startFakeDevTools(): Promise<number> {
  server = http.createServer((request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:0/devtools/browser/x" }));
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as { port: number }).port;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

function fakeSession(windowState: string, calls: string[]) {
  return async () => ({
    send: async <T,>(method: string): Promise<T> => {
      calls.push(method);
      if (method === "Browser.getWindowForTarget") {
        return { windowId: 7, bounds: { windowState } } as T;
      }
      return {} as T;
    },
    close: () => calls.push("close")
  });
}

describe("ensureWindowNotMinimized", () => {
  test("restores a minimized window so its renderer is not frozen", async () => {
    const port = await startFakeDevTools();
    const calls: string[] = [];

    const outcome = await ensureWindowNotMinimized(port, "target-1", fakeSession("minimized", calls));

    expect(outcome).toBe("restored");
    expect(calls).toContain("Browser.setWindowBounds");
    expect(calls).toContain("close");
  });

  test("leaves a visible window alone", async () => {
    const port = await startFakeDevTools();
    const calls: string[] = [];

    const outcome = await ensureWindowNotMinimized(port, "target-1", fakeSession("normal", calls));

    expect(outcome).toBe("already-visible");
    expect(calls).not.toContain("Browser.setWindowBounds");
  });

  test("stays best-effort when the browser endpoint is unreachable", async () => {
    // Nothing is listening: the repair must not throw, because the caller's own
    // command timeout is the real error path.
    const outcome = await ensureWindowNotMinimized(1, "target-1", fakeSession("minimized", []));
    expect(outcome).toBe("unknown");
  });
});
