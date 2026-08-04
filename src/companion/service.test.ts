import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RuntimeDatabase } from "../runtime/database.js";
import { RuntimeEventBus } from "../runtime/events.js";
import { CompanionService } from "./service.js";
import { CompanionStore } from "./store.js";

let home: string;
let database: RuntimeDatabase;
let now: Date;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-companion-"));
  database = new RuntimeDatabase(home);
  now = new Date("2026-07-31T12:00:00.000Z");
});

afterEach(async () => {
  database.close();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function service(options: {
  quiet?: boolean;
  threshold?: number;
} = {}): CompanionService {
  const hour = now.getHours();
  const quietHours = options.quiet
    ? { startHour: hour, endHour: (hour + 1) % 24 }
    : { startHour: (hour + 1) % 24, endHour: (hour + 2) % 24 };
  return new CompanionService(
    new CompanionStore(database),
    new RuntimeEventBus(database),
    {
      now: () => new Date(now),
      quietHours,
      threshold: options.threshold
    }
  );
}

describe("CompanionService", () => {
  test("turns a semantic arrival home into an auditable speaking intent", () => {
    const companion = service();
    companion.updatePresence({ state: "away", ttlMinutes: 60 });
    const result = companion.updatePresence({
      state: "home",
      source: "geofence",
      confidence: 0.95,
      ttlMinutes: 180
    });

    expect(result.presence).toMatchObject({
      state: "home",
      source: "geofence",
      confidence: 0.95
    });
    expect(result.intent).toMatchObject({
      action: "speak",
      candidate: "welcome_home",
      trigger: "presence_update"
    });
    expect(result.intent.message).toMatch(/welcome home/i);
    expect(result.intent.score.total).toBeGreaterThanOrEqual(result.intent.score.threshold);
    expect(companion.state().recentIntents[0].id).toBe(result.intent.id);

    expect(
      new RuntimeEventBus(database).history().map((event) => event.type)
    ).toEqual([
      "companion.presence.updated",
      "companion.intent.evaluated",
      "companion.presence.updated",
      "companion.intent.evaluated"
    ]);
  });

  test.each([
    ["focus", /do-not-disturb/i],
    ["transit", /privacy cost/i],
    ["unknown", /insufficient context/i],
    ["away", /insufficient context/i]
  ] as const)("fails closed to silence for %s presence", (state, reason) => {
    const companion = service();
    const { intent } = companion.updatePresence({ state, confidence: 1 });
    expect(intent.action).toBe("silence");
    expect(intent.message).toBeUndefined();
    expect(intent.reason).toMatch(reason);
  });

  test("treats expired presence as silence and exposes inactive state", () => {
    const companion = service();
    const { intent } = companion.updatePresence({
      state: "home",
      observedAt: "2026-07-31T09:00:00.000Z",
      ttlMinutes: 60
    });
    expect(intent).toMatchObject({ action: "silence" });
    expect(intent.reason).toMatch(/expired/i);
    expect(companion.state()).toMatchObject({
      presence: { state: "home" },
      presenceActive: false
    });
  });

  test("evaluates a backfilled observation against the record just accepted", () => {
    const companion = service();
    companion.updatePresence({
      state: "home",
      observedAt: "2026-07-31T11:30:00.000Z",
      ttlMinutes: 120
    });
    const backfill = companion.updatePresence({
      state: "focus",
      source: "calendar",
      observedAt: "2026-07-31T11:00:00.000Z",
      ttlMinutes: 120
    });

    expect(backfill).toMatchObject({
      presence: { state: "focus" },
      intent: {
        presenceId: backfill.presence.id,
        action: "silence",
        reason: expect.stringMatching(/do-not-disturb/i)
      }
    });
    expect(companion.state().presence).toMatchObject({ state: "home" });
  });

  test("quiet hours and pause override a candidate that otherwise speaks", () => {
    const quietCompanion = service({ quiet: true });
    const quiet = quietCompanion.updatePresence({ state: "available" }).intent;
    expect(quiet.action).toBe("silence");
    expect(quiet.reason).toMatch(/quiet hours/i);

    const activeCompanion = service();
    activeCompanion.pause(30);
    const paused = activeCompanion.updatePresence({ state: "home" }).intent;
    expect(paused.action).toBe("silence");
    expect(paused.reason).toMatch(/paused until/i);

    activeCompanion.resume();
    expect(activeCompanion.evaluate()).toMatchObject({ action: "speak" });
  });

  test("an elapsed timed pause stops suppressing conversation", () => {
    const companion = service();
    companion.pause(5);
    now = new Date(now.getTime() + 6 * 60_000);
    expect(companion.updatePresence({ state: "available" }).intent.action).toBe("speak");
    expect(companion.state().settings.pause).toEqual({ paused: false });
  });

  test("validates confidence, TTL, source, and future observations", () => {
    const companion = service();
    expect(() => companion.updatePresence({
      state: "home",
      confidence: 1.1
    })).toThrow(/confidence/i);
    expect(() => companion.updatePresence({
      state: "home",
      ttlMinutes: 0
    })).toThrow(/ttlMinutes/i);
    expect(() => companion.updatePresence({
      state: "home",
      source: "gps" as never
    })).toThrow(/source/i);
    expect(() => companion.updatePresence({
      state: "home",
      observedAt: "2026-07-31T13:00:00.000Z"
    })).toThrow(/future/i);
    expect(() => companion.updatePresence({
      state: "home",
      observedAt: "July 31, 2026 12:00"
    })).toThrow(/ISO-8601/i);
  });

  test("forgets semantic presence while retaining intent evidence", () => {
    const companion = service();
    companion.updatePresence({ state: "home" });
    expect(companion.forgetPresence()).toEqual({ forgotten: 1 });
    expect(companion.state()).toMatchObject({
      presence: null,
      presenceActive: false
    });
    expect(companion.state().recentIntents).toHaveLength(1);
  });

  test("persists presence, pause, and intents across database reopen", () => {
    const companion = service();
    const created = companion.updatePresence({
      state: "available",
      source: "device",
      ttlMinutes: 240
    });
    companion.pause();
    database.close();

    database = new RuntimeDatabase(home);
    const reloaded = service();
    expect(reloaded.state()).toMatchObject({
      presence: {
        id: created.presence.id,
        state: "available",
        source: "device"
      },
      settings: {
        pause: { paused: true }
      }
    });
    expect(reloaded.state().recentIntents[0].id).toBe(created.intent.id);
  });
});
