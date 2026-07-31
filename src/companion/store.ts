import crypto from "node:crypto";
import type { RuntimeDatabase } from "../runtime/database.js";
import type {
  CompanionDelivery,
  CompanionIntent,
  CompanionIntentAction,
  CompanionIntentTrigger,
  CompanionPauseState,
  CompanionScore,
  DeliveryStatus,
  PresenceRecord,
  PresenceSource,
  PresenceState
} from "./types.js";

interface PresenceRow {
  id: string;
  state: PresenceState;
  source: PresenceSource;
  confidence: number;
  observed_at: string;
  expires_at: string;
  created_at: string;
}

interface CompanionIntentRow {
  id: string;
  presence_id: string | null;
  trigger: CompanionIntentTrigger;
  candidate: CompanionIntent["candidate"];
  action: CompanionIntentAction;
  message: string | null;
  reason: string;
  score_json: string;
  created_at: string;
}

interface CompanionSettingRow {
  value_json: string;
}

interface CompanionDeliveryRow {
  id: string;
  intent_id: string;
  channel: string;
  status: DeliveryStatus;
  attempts: number;
  detail: string | null;
  created_at: string;
  attempted_at: string | null;
  delivered_at: string | null;
}

const DELIVERY_COLUMNS = `
  SELECT id, intent_id, channel, status, attempts, detail,
         created_at, attempted_at, delivered_at
  FROM companion_deliveries
`;

/** Raised when a delivery already exists for an (intent, channel) pair. */
export class DuplicateDeliveryError extends Error {
  constructor(readonly existing: CompanionDelivery) {
    super(`Delivery already recorded for intent ${existing.intentId} on ${existing.channel}.`);
    this.name = "DuplicateDeliveryError";
  }
}

export class CompanionStore {
  constructor(private readonly runtime: RuntimeDatabase) {}

  createPresence(input: Omit<PresenceRecord, "id">): PresenceRecord {
    const presence: PresenceRecord = {
      ...input,
      id: this.newId("presence")
    };
    this.runtime.connection.prepare(`
      INSERT INTO companion_presence (
        id, state, source, confidence, observed_at, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      presence.id,
      presence.state,
      presence.source,
      presence.confidence,
      presence.observedAt,
      presence.expiresAt,
      presence.createdAt
    );
    return presence;
  }

  latestPresence(): PresenceRecord | null {
    const row = this.runtime.connection.prepare(`
      SELECT id, state, source, confidence, observed_at, expires_at, created_at
      FROM companion_presence
      ORDER BY observed_at DESC, sequence DESC
      LIMIT 1
    `).get() as PresenceRow | undefined;
    return row ? this.presenceFromRow(row) : null;
  }

  getPresence(id: string): PresenceRecord | null {
    const row = this.runtime.connection.prepare(`
      SELECT id, state, source, confidence, observed_at, expires_at, created_at
      FROM companion_presence
      WHERE id = ?
    `).get(id) as PresenceRow | undefined;
    return row ? this.presenceFromRow(row) : null;
  }

  forgetPresence(): number {
    return Number(this.runtime.connection.prepare(
      "DELETE FROM companion_presence"
    ).run().changes);
  }

  createIntent(input: Omit<CompanionIntent, "id">): CompanionIntent {
    const intent: CompanionIntent = {
      ...input,
      id: this.newId("intent")
    };
    this.runtime.connection.prepare(`
      INSERT INTO companion_intents (
        id, presence_id, trigger, candidate, action, message, reason,
        score_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      intent.id,
      intent.presenceId ?? null,
      intent.trigger,
      intent.candidate,
      intent.action,
      intent.message ?? null,
      intent.reason,
      JSON.stringify(intent.score),
      intent.createdAt
    );
    return intent;
  }

  listIntents(limit = 20): CompanionIntent[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = this.runtime.connection.prepare(`
      SELECT id, presence_id, trigger, candidate, action, message, reason,
             score_json, created_at
      FROM companion_intents
      ORDER BY sequence DESC
      LIMIT ?
    `).all(safeLimit) as unknown as CompanionIntentRow[];
    return rows.map((row) => this.intentFromRow(row));
  }

  /**
   * Claims the (intent, channel) delivery slot. The unique index makes this the
   * single point where duplicate or replayed delivery is rejected, so callers
   * can treat a successful insert as exclusive ownership of the attempt.
   */
  createDelivery(input: Omit<CompanionDelivery, "id">): CompanionDelivery {
    const delivery: CompanionDelivery = { ...input, id: this.newId("delivery") };
    try {
      this.runtime.connection.prepare(`
        INSERT INTO companion_deliveries (
          id, intent_id, channel, status, attempts, detail,
          created_at, attempted_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        delivery.id,
        delivery.intentId,
        delivery.channel,
        delivery.status,
        delivery.attempts,
        delivery.detail ?? null,
        delivery.createdAt,
        delivery.attemptedAt ?? null,
        delivery.deliveredAt ?? null
      );
    } catch (error) {
      const existing = this.findDelivery(delivery.intentId, delivery.channel);
      if (existing) throw new DuplicateDeliveryError(existing);
      throw error;
    }
    return delivery;
  }

  updateDelivery(
    id: string,
    patch: Pick<CompanionDelivery, "status" | "attempts">
      & Partial<Pick<CompanionDelivery, "detail" | "attemptedAt" | "deliveredAt">>
  ): CompanionDelivery {
    this.runtime.connection.prepare(`
      UPDATE companion_deliveries
      SET status = ?, attempts = ?, detail = ?, attempted_at = ?, delivered_at = ?
      WHERE id = ?
    `).run(
      patch.status,
      patch.attempts,
      patch.detail ?? null,
      patch.attemptedAt ?? null,
      patch.deliveredAt ?? null,
      id
    );
    const updated = this.getDelivery(id);
    if (!updated) throw new Error(`Delivery ${id} not found.`);
    return updated;
  }

  getDelivery(id: string): CompanionDelivery | null {
    const row = this.runtime.connection.prepare(`
      ${DELIVERY_COLUMNS}
      WHERE id = ?
    `).get(id) as CompanionDeliveryRow | undefined;
    return row ? this.deliveryFromRow(row) : null;
  }

  findDelivery(intentId: string, channel: string): CompanionDelivery | null {
    const row = this.runtime.connection.prepare(`
      ${DELIVERY_COLUMNS}
      WHERE intent_id = ? AND channel = ?
    `).get(intentId, channel) as CompanionDeliveryRow | undefined;
    return row ? this.deliveryFromRow(row) : null;
  }

  listDeliveries(limit = 20): CompanionDelivery[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = this.runtime.connection.prepare(`
      ${DELIVERY_COLUMNS}
      ORDER BY sequence DESC
      LIMIT ?
    `).all(safeLimit) as unknown as CompanionDeliveryRow[];
    return rows.map((row) => this.deliveryFromRow(row));
  }

  /** Most recent successful delivery on a channel, used for cooldown checks. */
  lastDeliveredAt(channel: string): string | null {
    const row = this.runtime.connection.prepare(`
      SELECT delivered_at
      FROM companion_deliveries
      WHERE channel = ? AND status = 'delivered' AND delivered_at IS NOT NULL
      ORDER BY sequence DESC
      LIMIT 1
    `).get(channel) as { delivered_at: string } | undefined;
    return row?.delivered_at ?? null;
  }

  /**
   * Per-channel opt-in. Absent means disabled: a channel only speaks after the
   * user turns it on, so a fresh install never notifies unprompted.
   */
  getChannelPolicy(): Record<string, boolean> {
    const row = this.runtime.connection.prepare(`
      SELECT value_json
      FROM companion_settings
      WHERE key = 'channels'
    `).get() as CompanionSettingRow | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
      const policy: Record<string, boolean> = {};
      for (const [channel, enabled] of Object.entries(parsed)) {
        policy[channel] = enabled === true;
      }
      return policy;
    } catch {
      return {};
    }
  }

  setChannelEnabled(channel: string, enabled: boolean): Record<string, boolean> {
    const policy = { ...this.getChannelPolicy(), [channel]: enabled };
    this.runtime.connection.prepare(`
      INSERT INTO companion_settings (key, value_json, updated_at)
      VALUES ('channels', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(policy), new Date().toISOString());
    return policy;
  }

  getPause(): CompanionPauseState {
    const row = this.runtime.connection.prepare(`
      SELECT value_json
      FROM companion_settings
      WHERE key = 'pause'
    `).get() as CompanionSettingRow | undefined;
    if (!row) return { paused: false };
    try {
      const parsed = JSON.parse(row.value_json) as CompanionPauseState;
      return {
        paused: parsed.paused === true,
        pausedAt: typeof parsed.pausedAt === "string" ? parsed.pausedAt : undefined,
        pausedUntil: typeof parsed.pausedUntil === "string" ? parsed.pausedUntil : undefined
      };
    } catch {
      return { paused: false };
    }
  }

  setPause(pause: CompanionPauseState): CompanionPauseState {
    const now = new Date().toISOString();
    this.runtime.connection.prepare(`
      INSERT INTO companion_settings (key, value_json, updated_at)
      VALUES ('pause', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(pause), now);
    return pause;
  }

  private presenceFromRow(row: PresenceRow): PresenceRecord {
    return {
      id: row.id,
      state: row.state,
      source: row.source,
      confidence: row.confidence,
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at
    };
  }

  private intentFromRow(row: CompanionIntentRow): CompanionIntent {
    return {
      id: row.id,
      presenceId: row.presence_id ?? undefined,
      trigger: row.trigger,
      candidate: row.candidate,
      action: row.action,
      message: row.message ?? undefined,
      reason: row.reason,
      score: JSON.parse(row.score_json) as CompanionScore,
      createdAt: row.created_at
    };
  }

  private deliveryFromRow(row: CompanionDeliveryRow): CompanionDelivery {
    return {
      id: row.id,
      intentId: row.intent_id,
      channel: row.channel,
      status: row.status,
      attempts: row.attempts,
      detail: row.detail ?? undefined,
      createdAt: row.created_at,
      attemptedAt: row.attempted_at ?? undefined,
      deliveredAt: row.delivered_at ?? undefined
    };
  }

  private newId(prefix: "presence" | "intent" | "delivery"): string {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `${prefix}-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  }
}
