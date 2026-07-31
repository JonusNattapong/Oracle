import crypto from "node:crypto";
import type { RuntimeDatabase } from "../runtime/database.js";
import type {
  CompanionIntent,
  CompanionIntentAction,
  CompanionIntentTrigger,
  CompanionPauseState,
  CompanionScore,
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

  private newId(prefix: "presence" | "intent"): string {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `${prefix}-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  }
}
