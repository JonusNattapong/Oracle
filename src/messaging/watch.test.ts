import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MessageStore, type AgentMessage } from "./store.js";
import { watchInbox } from "./watch.js";
import type { FSWatcher } from "chokidar";

let home: string;
let store: MessageStore;
let watcher: FSWatcher | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-msg-watch-"));
  store = new MessageStore(home);
});

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  store.dispose();
  await fs.rm(home, { recursive: true, force: true });
});

function waitFor<T>(check: () => T | undefined, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = check();
      if (value !== undefined) return resolve(value);
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe.skip("watchInbox", () => {
  test("fires for a new message to the agent, not for messages to others", async () => {
    const received: AgentMessage[] = [];
    watcher = await watchInbox(home, "codex", (m) => {
      received.push(m);
    });

    // Give chokidar a moment to arm before writing.
    await new Promise((r) => setTimeout(r, 300));

    await store.send({ from: "claude", to: "gemini", body: "not for codex" });
    await store.send({ from: "claude", to: "codex", body: "wake up" });

    const first = await waitFor(() => received[0]);
    expect(first.body).toBe("wake up");
    expect(received).toHaveLength(1);
  });

  test("fires for broadcasts but not the agent's own sends", async () => {
    const received: AgentMessage[] = [];
    watcher = await watchInbox(home, "codex", (m) => {
      received.push(m);
    });
    await new Promise((r) => setTimeout(r, 300));

    await store.send({ from: "codex", to: "*", body: "my own broadcast" });
    await store.send({ from: "claude", to: "*", body: "everyone hear this" });

    const first = await waitFor(() => received[0]);
    expect(first.body).toBe("everyone hear this");
    expect(received).toHaveLength(1);
  });
});
