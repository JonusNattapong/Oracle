import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RuntimeDatabase } from "../runtime/database.js";
import { RuntimeEventBus } from "../runtime/events.js";
import { CompanionDeliveryService } from "./delivery.js";
import { CompanionService } from "./service.js";
import { CompanionStore } from "./store.js";
import type {
  CompanionIntent,
  CompanionNotifier,
  DeliveryResult
} from "./types.js";

let home: string;
let database: RuntimeDatabase;
let now: Date;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-delivery-"));
  database = new RuntimeDatabase(home);
  now = new Date("2026-07-31T12:00:00.000Z");
});

afterEach(async () => {
  database.close();
  await fs.rm(home, { recursive: true, force: true });
});

/** Records every intent it is handed, so tests can assert on what reached a channel. */
class RecordingNotifier implements CompanionNotifier {
  readonly channel: string;
  readonly delivered: CompanionIntent[] = [];

  constructor(
    private readonly result: DeliveryResult = { delivered: true },
    readonly enabled = true,
    readonly available = true,
    readonly unavailableReason?: string,
    channel = "test-channel"
  ) {
    this.channel = channel;
  }

  async deliver(intent: CompanionIntent): Promise<DeliveryResult> {
    this.delivered.push(intent);
    return this.result;
  }
}

class ThrowingNotifier implements CompanionNotifier {
  readonly channel = "throwing-channel";
  readonly enabled = true;
  readonly available = true;

  async deliver(): Promise<DeliveryResult> {
    throw new Error("channel exploded");
  }
}

interface Harness {
  companion: CompanionService;
  delivery: CompanionDeliveryService;
  store: CompanionStore;
  events: RuntimeEventBus;
  dispatched: Promise<unknown>[];
}

function harness(options: {
  notifier?: CompanionNotifier;
  quiet?: boolean;
  cooldownMinutes?: number;
  autoDispatch?: boolean;
  channelEnabled?: boolean;
} = {}): Harness {
  const hour = now.getHours();
  const quietHours = options.quiet
    ? { startHour: hour, endHour: (hour + 1) % 24 }
    : { startHour: (hour + 1) % 24, endHour: (hour + 2) % 24 };
  const store = new CompanionStore(database);
  const events = new RuntimeEventBus(database);
  const companion = new CompanionService(store, events, {
    now: () => new Date(now),
    quietHours
  });
  const notifier = options.notifier ?? new RecordingNotifier();
  const delivery = new CompanionDeliveryService(
    store,
    companion,
    events,
    [notifier],
    { now: () => new Date(now), cooldownMinutes: options.cooldownMinutes ?? 0 }
  );
  // Channels are opt-in; every test that expects delivery turns one on.
  if (options.channelEnabled !== false) {
    store.setChannelEnabled(notifier.channel, true);
  }
  // The daemon installs the dispatcher; tests drive dispatch explicitly so the
  // automatic path cannot race an assertion. autoDispatch covers that wiring.
  const dispatched: Promise<unknown>[] = [];
  if (options.autoDispatch) {
    companion.setDispatcher((intent) => {
      dispatched.push(delivery.dispatch(intent));
    });
  }
  return { companion, delivery, store, events, dispatched };
}

function eventTypes(): string[] {
  return new RuntimeEventBus(database).history(0, 500).map((event) => event.type);
}

describe("CompanionDeliveryService", () => {
  test("delivers a speak intent exactly once", async () => {
    const notifier = new RecordingNotifier();
    const { companion, delivery } = harness({ notifier });
    companion.updatePresence({ state: "away", ttlMinutes: 60 });
    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    expect(intent.action).toBe("speak");

    const [first] = await delivery.dispatch(intent);
    expect(first).toMatchObject({
      intentId: intent.id,
      channel: "test-channel",
      status: "delivered",
      attempts: 1
    });
    expect(first.deliveredAt).toBeDefined();

    // Re-dispatching the same intent is idempotent: no second notification.
    const [second] = await delivery.dispatch(intent);
    expect(second.id).toBe(first.id);
    expect(notifier.delivered).toHaveLength(1);
    expect(delivery.listDeliveries()).toHaveLength(1);
    expect(eventTypes()).toContain("companion.delivery.delivered");
  });

  test("never dispatches a silence intent to any channel", async () => {
    const notifier = new RecordingNotifier();
    const { companion, delivery } = harness({ notifier });
    const intent = companion.evaluate("manual");
    expect(intent.action).toBe("silence");

    expect(await delivery.dispatch(intent)).toEqual([]);
    expect(notifier.delivered).toHaveLength(0);
    expect(delivery.listDeliveries()).toEqual([]);
  });

  test.each(["focus", "transit", "away"])(
    "suppresses a stale intent once %s presence supersedes it",
    async (state) => {
      const notifier = new RecordingNotifier();
      const { companion, delivery } = harness({ notifier });
      const { intent: speaking } = companion.updatePresence({
        state: "home",
        ttlMinutes: 120
      });
      expect(speaking.action).toBe("speak");

      // The situation changes between decision and delivery.
      const changed = companion.updatePresence({
        state: state as "focus",
        ttlMinutes: 120
      });
      expect(changed.intent.action).toBe("silence");

      const [result] = await delivery.dispatch(speaking);
      expect(result.status).toBe("suppressed");
      expect(result.detail).toMatch(/superseded/i);
      expect(notifier.delivered).toHaveLength(0);
    }
  );

  test("suppresses delivery once the companion is paused", async () => {
    const notifier = new RecordingNotifier();
    const { companion, delivery } = harness({ notifier });
    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    companion.pause();

    const [result] = await delivery.dispatch(intent);
    expect(result.status).toBe("suppressed");
    expect(result.detail).toMatch(/paused/i);
    expect(notifier.delivered).toHaveLength(0);
    expect(eventTypes()).toContain("companion.delivery.suppressed");
  });

  test("suppresses delivery once the referenced presence has expired", async () => {
    const notifier = new RecordingNotifier();
    const { companion, delivery } = harness({ notifier });
    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 30 });

    now = new Date(now.getTime() + 60 * 60_000);
    const [result] = await delivery.dispatch(intent);
    expect(result.status).toBe("suppressed");
    expect(result.detail).toMatch(/expired/i);
    expect(notifier.delivered).toHaveLength(0);
  });

  test("suppresses delivery inside quiet hours", async () => {
    const notifier = new RecordingNotifier();
    const permissive = harness({ notifier });
    const { intent } = permissive.companion.updatePresence({
      state: "home",
      ttlMinutes: 120
    });

    const quiet = harness({ notifier, quiet: true });
    const [result] = await quiet.delivery.dispatch(intent);
    expect(result.status).toBe("suppressed");
    expect(result.detail).toMatch(/quiet hours/i);
    expect(notifier.delivered).toHaveLength(0);
  });

  test("suppresses delivery when the presence record has been forgotten", async () => {
    const notifier = new RecordingNotifier();
    const { companion, delivery } = harness({ notifier });
    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    companion.forgetPresence();

    const [result] = await delivery.dispatch(intent);
    expect(result.status).toBe("suppressed");
    expect(result.detail).toMatch(/no semantic presence/i);
    expect(notifier.delivered).toHaveLength(0);
  });

  test("suppresses delivery on a disabled or unavailable channel", async () => {
    const disabled = new RecordingNotifier({ delivered: true }, false, true);
    const first = harness({ notifier: disabled });
    const { intent } = first.companion.updatePresence({ state: "home", ttlMinutes: 120 });
    const [disabledResult] = await first.delivery.dispatch(intent);
    expect(disabledResult.status).toBe("suppressed");
    expect(disabledResult.detail).toMatch(/disabled/i);

    const unavailable = new RecordingNotifier(
      { delivered: true },
      true,
      false,
      "No local channel on this platform.",
      "other-channel"
    );
    const second = harness({ notifier: unavailable });
    const [unavailableResult] = await second.delivery.dispatch(intent);
    expect(unavailableResult.status).toBe("suppressed");
    expect(unavailableResult.detail).toMatch(/no local channel/i);
    expect(disabled.delivered).toHaveLength(0);
    expect(unavailable.delivered).toHaveLength(0);
  });

  test("applies a cooldown so rapid arrivals cannot spam the user", async () => {
    const notifier = new RecordingNotifier();
    const { companion, delivery } = harness({ notifier, cooldownMinutes: 30 });
    companion.updatePresence({ state: "away", ttlMinutes: 60 });
    const first = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    expect((await delivery.dispatch(first.intent))[0].status).toBe("delivered");

    // Presence oscillates a minute later.
    now = new Date(now.getTime() + 60_000);
    companion.updatePresence({ state: "away", ttlMinutes: 60 });
    const second = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    const [cooled] = await delivery.dispatch(second.intent);
    expect(cooled.status).toBe("suppressed");
    expect(cooled.detail).toMatch(/cooldown/i);
    expect(notifier.delivered).toHaveLength(1);

    // Past the cooldown window the channel is usable again.
    now = new Date(now.getTime() + 31 * 60_000);
    companion.updatePresence({ state: "away", ttlMinutes: 60 });
    const third = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    expect((await delivery.dispatch(third.intent))[0].status).toBe("delivered");
    expect(notifier.delivered).toHaveLength(2);
  });

  test("persists a failed delivery without throwing", async () => {
    const failing = new RecordingNotifier({
      delivered: false,
      errorKind: "exit_code",
      detail: "PowerShell exited with code 1."
    });
    const { companion, delivery } = harness({ notifier: failing });
    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 120 });

    const [result] = await delivery.dispatch(intent);
    expect(result).toMatchObject({ status: "failed", attempts: 1 });
    expect(result.detail).toMatch(/exited with code 1/);
    expect(result.deliveredAt).toBeUndefined();
    expect(eventTypes()).toContain("companion.delivery.failed");
  });

  test("treats a throwing channel as a failed delivery", async () => {
    const { companion, delivery } = harness({ notifier: new ThrowingNotifier() });
    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 120 });

    const [result] = await delivery.dispatch(intent);
    expect(result.status).toBe("failed");
    expect(delivery.listDeliveries()).toHaveLength(1);
  });

  test("keeps message text and failure detail out of replayable events", async () => {
    const failing = new RecordingNotifier({
      delivered: false,
      errorKind: "exit_code",
      detail: "C:\\Users\\secret\\path exploded"
    });
    const { companion, delivery } = harness({ notifier: failing });
    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    await delivery.dispatch(intent);

    const payloads = new RuntimeEventBus(database)
      .history(0, 500)
      .filter((event) => event.type.startsWith("companion.delivery."))
      .map((event) => JSON.stringify(event.payload));
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toContain("secret");
      expect(payload).not.toContain(intent.message ?? "@@none@@");
    }
    expect(payloads.join(" ")).toContain("exit_code");
  });

  test("does not redeliver a completed intent after a restart", async () => {
    const notifier = new RecordingNotifier();
    const first = harness({ notifier });
    const { intent } = first.companion.updatePresence({ state: "home", ttlMinutes: 120 });
    expect((await first.delivery.dispatch(intent))[0].status).toBe("delivered");

    // A fresh service over the same database stands in for a daemon restart.
    const restarted = harness({ notifier });
    const [replayed] = await restarted.delivery.dispatch(intent);
    expect(replayed.status).toBe("delivered");
    expect(notifier.delivered).toHaveLength(1);
    expect(restarted.delivery.listDeliveries()).toHaveLength(1);
  });

  test("reports channel status without exposing host detail", () => {
    const { delivery } = harness({
      notifier: new RecordingNotifier(
        { delivered: true },
        true,
        false,
        "Windows toast notifications are unavailable on platform \"linux\"."
      )
    });
    expect(delivery.channels()).toEqual([
      {
        channel: "test-channel",
        enabled: true,
        available: false,
        reason: "Windows toast notifications are unavailable on platform \"linux\"."
      }
    ]);
  });

  test("a presence update enqueues delivery for a speak intent", async () => {
    const notifier = new RecordingNotifier();
    const { companion, delivery, dispatched } = harness({
      notifier,
      autoDispatch: true
    });
    companion.updatePresence({ state: "away", ttlMinutes: 60 });
    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    await Promise.all(dispatched);

    expect(intent.action).toBe("speak");
    expect(notifier.delivered.map((item) => item.id)).toEqual([intent.id]);
    expect(delivery.listDeliveries()).toHaveLength(1);
  });

  test("a failing channel does not fail the presence update", async () => {
    const { companion, delivery, dispatched } = harness({
      notifier: new ThrowingNotifier(),
      autoDispatch: true
    });
    const result = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    await Promise.all(dispatched);

    // The presence observation and its intent are intact and auditable.
    expect(result.presence.state).toBe("home");
    expect(result.intent.action).toBe("speak");
    expect(companion.state().presence?.id).toBe(result.presence.id);
    expect(delivery.listDeliveries()[0].status).toBe("failed");
  });

  test("stays silent until the user opts a channel in", async () => {
    const notifier = new RecordingNotifier();
    const { companion, delivery } = harness({ notifier, channelEnabled: false });
    expect(delivery.channels()).toEqual([
      { channel: "test-channel", enabled: false, available: true, reason: undefined }
    ]);

    const { intent } = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    const [suppressed] = await delivery.dispatch(intent);
    expect(suppressed.status).toBe("suppressed");
    expect(suppressed.detail).toMatch(/not enabled/i);
    expect(notifier.delivered).toHaveLength(0);

    delivery.setChannelEnabled("test-channel", true);
    expect(delivery.channels()[0].enabled).toBe(true);
    expect(eventTypes()).toContain("companion.channel.updated");

    // A new intent is required: the first one already holds its delivery slot.
    companion.updatePresence({ state: "away", ttlMinutes: 60 });
    const next = companion.updatePresence({ state: "home", ttlMinutes: 120 });
    expect((await delivery.dispatch(next.intent))[0].status).toBe("delivered");
    expect(notifier.delivered).toHaveLength(1);
  });

  test("rejects enabling an unknown channel", () => {
    const { delivery } = harness();
    expect(() => delivery.setChannelEnabled("telegram", true)).toThrow(/unknown/i);
  });

  test("rejects an out-of-range cooldown", () => {
    const store = new CompanionStore(database);
    const events = new RuntimeEventBus(database);
    const companion = new CompanionService(store, events, { now: () => new Date(now) });
    expect(() => new CompanionDeliveryService(store, companion, events, [], {
      cooldownMinutes: -1
    })).toThrow(/cooldownMinutes/);
  });
});
