import path from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { MessageStore, type AgentMessage } from "./store.js";

/**
 * Watch the SQLite WAL/database files and deliver newly-visible inbox rows.
 * The query is the source of truth; filesystem events are only a wake-up
 * signal, so coalesced WAL events cannot lose messages.
 */
export async function watchInbox(
  homeDir: string,
  agent: string,
  onMessage: (message: AgentMessage) => void | Promise<void>
): Promise<FSWatcher> {
  const store = new MessageStore(homeDir);
  const initial = await store.inbox(agent, { unreadOnly: true, limit: 1000 });
  const seen = new Set(initial.map((message) => message.id));
  const runtimeDir = path.join(homeDir, "runtime");
  const watcher = chokidarWatch(runtimeDir, {
    ignoreInitial: true,
    depth: 0
  });

  let running = false;
  let rerun = false;
  const scan = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        const messages = await store.inbox(agent, {
          unreadOnly: true,
          limit: 1000
        });
        for (const message of messages) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          await onMessage(message);
        }
      } while (rerun);
    } finally {
      running = false;
    }
  };

  watcher.on("all", () => {
    scan().catch((err) => {
      console.error(`[message-watcher] Error scanning inbox: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  const origClose = watcher.close.bind(watcher);
  watcher.close = () => {
    store.dispose();
    return origClose() as Promise<void>;
  };
  return watcher;
}
