import type { RuntimeEventBus } from "../runtime/events.js";
import { CompanionStore } from "./store.js";
import {
  PRESENCE_SOURCES,
  PRESENCE_STATES,
  type CompanionIntent,
  type CompanionIntentTrigger,
  type CompanionPauseState,
  type CompanionScore,
  type CompanionStateSnapshot,
  type PresenceRecord,
  type PresenceState,
  type PresenceUpdateResult,
  type UpdatePresenceInput
} from "./types.js";

const DEFAULT_TTL_MINUTES = 120;
const MAX_TTL_MINUTES = 24 * 60;
const MAX_PAUSE_MINUTES = 7 * 24 * 60;
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_QUIET_HOURS = { startHour: 22, endHour: 8 };
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

interface CompanionServiceOptions {
  now?: () => Date;
  quietHours?: {
    startHour: number;
    endHour: number;
  };
  threshold?: number;
}

interface StateScoreProfile {
  relevance: number;
  relationalContinuity: number;
  urgency: number;
  interruptionCost: number;
  privacyRisk: number;
}

export class CompanionService {
  private readonly now: () => Date;
  private readonly quietHours: { startHour: number; endHour: number };
  private readonly threshold: number;
  private dispatch?: (intent: CompanionIntent) => void;

  constructor(
    private readonly store: CompanionStore,
    private readonly events: RuntimeEventBus,
    options: CompanionServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.quietHours = options.quietHours ?? DEFAULT_QUIET_HOURS;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.validateHour(this.quietHours.startHour, "quietHours.startHour");
    this.validateHour(this.quietHours.endHour, "quietHours.endHour");
    if (!Number.isFinite(this.threshold) || this.threshold < -1 || this.threshold > 3) {
      throw new Error("Companion threshold must be between -1 and 3.");
    }
  }

  updatePresence(input: UpdatePresenceInput): PresenceUpdateResult {
    this.validatePresenceInput(input);
    const previous = this.store.latestPresence();
    const now = this.now();
    const observedAt = input.observedAt ? new Date(input.observedAt) : now;
    const ttlMinutes = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    const presence = this.store.createPresence({
      state: input.state,
      source: input.source ?? "manual",
      confidence: input.confidence ?? 1,
      observedAt: observedAt.toISOString(),
      expiresAt: new Date(observedAt.getTime() + ttlMinutes * 60_000).toISOString(),
      createdAt: now.toISOString()
    });
    this.events.publish("companion.presence.updated", {
      presence,
      previousState: previous?.state ?? null
    });
    const intent = this.evaluatePresence(
      presence,
      "presence_update",
      previous?.state
    );
    return { presence, intent };
  }

  /**
   * Registers the sink that carries `speak` intents to notification channels.
   * Set after construction because delivery depends on this service, and a
   * failing sink must never affect the decision that produced the intent.
   */
  setDispatcher(dispatch: (intent: CompanionIntent) => void): void {
    this.dispatch = dispatch;
  }

  /**
   * Re-runs the Boundary against an intent at delivery time. Evaluation and
   * delivery are separate moments: presence may have expired, the user may have
   * paused, quiet hours may have begun. Returns a reason to suppress, or
   * undefined when speaking is still appropriate.
   */
  deliveryGuard(intent: CompanionIntent): string | undefined {
    if (intent.action !== "speak") {
      return "Intent action is not speak.";
    }
    const presence = intent.presenceId
      ? this.store.getPresence(intent.presenceId)
      : null;
    // A newer observation means the situation moved on since this intent was
    // formed. The newer observation produces its own intent, so suppressing
    // here loses nothing and keeps a stale decision from reaching the user.
    const latest = this.store.latestPresence();
    if (presence && latest && latest.id !== presence.id) {
      return "A newer presence observation superseded this intent.";
    }
    return this.gateReason(presence, this.now());
  }

  evaluate(
    trigger: CompanionIntentTrigger = "manual",
    previousState?: PresenceState
  ): CompanionIntent {
    return this.evaluatePresence(
      this.store.latestPresence(),
      trigger,
      previousState
    );
  }

  private evaluatePresence(
    presence: PresenceRecord | null,
    trigger: CompanionIntentTrigger,
    previousState?: PresenceState
  ): CompanionIntent {
    const now = this.now();
    const score = this.score(presence);
    const gateReason = this.gateReason(presence, now);
    const candidate = this.candidate(presence, previousState);
    const shouldSpeak = !gateReason && score.total >= score.threshold;
    const message = shouldSpeak ? this.message(candidate) : undefined;
    const reason = gateReason ?? (
      shouldSpeak
        ? `Candidate score ${score.total.toFixed(2)} met the ${score.threshold.toFixed(2)} threshold.`
        : `Candidate score ${score.total.toFixed(2)} did not meet the ${score.threshold.toFixed(2)} threshold.`
    );
    const intent = this.store.createIntent({
      presenceId: presence?.id,
      trigger,
      candidate: shouldSpeak ? candidate : "stay_silent",
      action: shouldSpeak ? "speak" : "silence",
      message,
      reason,
      score,
      createdAt: now.toISOString()
    });
    this.events.publish("companion.intent.evaluated", {
      intent
    });
    if (intent.action === "speak" && this.dispatch) {
      // The decision is already recorded. Delivery is best-effort from here, so
      // a broken notification channel cannot fail a presence update.
      try {
        this.dispatch(intent);
      } catch {
        // Delivery records its own failures; nothing to escalate.
      }
    }
    return intent;
  }

  state(limit = 20): CompanionStateSnapshot {
    const now = this.now();
    const presence = this.store.latestPresence();
    return {
      generatedAt: now.toISOString(),
      presence,
      presenceActive: this.isActive(presence, now),
      settings: {
        quietHours: { ...this.quietHours },
        threshold: this.threshold,
        pause: this.effectivePause(now)
      },
      recentIntents: this.store.listIntents(limit)
    };
  }

  pause(minutes?: number): CompanionPauseState {
    if (
      minutes !== undefined
      && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_PAUSE_MINUTES)
    ) {
      throw new Error(`minutes must be an integer between 1 and ${MAX_PAUSE_MINUTES}.`);
    }
    const now = this.now();
    const pause = this.store.setPause({
      paused: true,
      pausedAt: now.toISOString(),
      pausedUntil: minutes === undefined
        ? undefined
        : new Date(now.getTime() + minutes * 60_000).toISOString()
    });
    this.events.publish("companion.paused", {
      pausedAt: pause.pausedAt,
      pausedUntil: pause.pausedUntil ?? null
    });
    return pause;
  }

  resume(): CompanionPauseState {
    const pause = this.store.setPause({ paused: false });
    this.events.publish("companion.resumed", {});
    return pause;
  }

  forgetPresence(): { forgotten: number } {
    const forgotten = this.store.forgetPresence();
    this.events.publish("companion.presence.forgotten", { forgotten });
    return { forgotten };
  }

  private validatePresenceInput(input: UpdatePresenceInput): void {
    if (!PRESENCE_STATES.includes(input.state)) {
      throw new Error(`state must be one of: ${PRESENCE_STATES.join(", ")}.`);
    }
    if (input.source !== undefined && !PRESENCE_SOURCES.includes(input.source)) {
      throw new Error(`source must be one of: ${PRESENCE_SOURCES.join(", ")}.`);
    }
    if (
      input.confidence !== undefined
      && (
        typeof input.confidence !== "number"
        || !Number.isFinite(input.confidence)
        || input.confidence < 0
        || input.confidence > 1
      )
    ) {
      throw new Error("confidence must be a number between 0 and 1.");
    }
    if (
      input.ttlMinutes !== undefined
      && (
        !Number.isInteger(input.ttlMinutes)
        || input.ttlMinutes < 1
        || input.ttlMinutes > MAX_TTL_MINUTES
      )
    ) {
      throw new Error(`ttlMinutes must be an integer between 1 and ${MAX_TTL_MINUTES}.`);
    }
    if (input.observedAt !== undefined) {
      if (!ISO_TIMESTAMP.test(input.observedAt)) {
        throw new Error("observedAt must be a valid ISO-8601 timestamp with a timezone.");
      }
      const observedAt = new Date(input.observedAt);
      if (Number.isNaN(observedAt.getTime())) {
        throw new Error("observedAt must be a valid ISO-8601 timestamp with a timezone.");
      }
      if (observedAt.getTime() > this.now().getTime() + 5 * 60_000) {
        throw new Error("observedAt cannot be more than 5 minutes in the future.");
      }
    }
  }

  private gateReason(presence: PresenceRecord | null, now: Date): string | undefined {
    const pause = this.effectivePause(now);
    if (pause.paused) {
      return pause.pausedUntil
        ? `Companion is paused until ${pause.pausedUntil}.`
        : "Companion is paused until explicitly resumed.";
    }
    if (!presence) return "No semantic presence is available; failing closed to silence.";
    if (!this.isActive(presence, now)) {
      return `Presence expired at ${presence.expiresAt}; failing closed to silence.`;
    }
    if (presence.state === "focus") {
      return "Focus presence is a do-not-disturb boundary.";
    }
    if (presence.state === "transit") {
      return "Transit presence carries elevated interruption and privacy cost.";
    }
    if (presence.state === "away" || presence.state === "unknown") {
      return `${presence.state} presence is insufficient context for an interruption.`;
    }
    if (this.isQuietHour(now)) {
      return `Local hour ${now.getHours()} is inside quiet hours ${this.quietHours.startHour}:00-${this.quietHours.endHour}:00.`;
    }
    return undefined;
  }

  private effectivePause(now: Date): CompanionPauseState {
    const pause = this.store.getPause();
    if (!pause.paused) return { paused: false };
    if (pause.pausedUntil && new Date(pause.pausedUntil).getTime() <= now.getTime()) {
      return { paused: false };
    }
    return pause;
  }

  private isActive(presence: PresenceRecord | null, now: Date): boolean {
    return Boolean(
      presence
      && new Date(presence.observedAt).getTime() <= now.getTime()
      && new Date(presence.expiresAt).getTime() > now.getTime()
    );
  }

  private isQuietHour(now: Date): boolean {
    const hour = now.getHours();
    const { startHour, endHour } = this.quietHours;
    if (startHour === endHour) return false;
    return startHour < endHour
      ? hour >= startHour && hour < endHour
      : hour >= startHour || hour < endHour;
  }

  private candidate(
    presence: PresenceRecord | null,
    previousState?: PresenceState
  ): CompanionIntent["candidate"] {
    if (presence?.state === "home") {
      return previousState && previousState !== "home" ? "welcome_home" : "check_in";
    }
    if (presence?.state === "available") return "open_conversation";
    return "stay_silent";
  }

  private message(candidate: CompanionIntent["candidate"]): string | undefined {
    switch (candidate) {
      case "welcome_home":
        return "Welcome home. How did things go while you were out?";
      case "check_in":
        return "You are home. Is there anything you want to talk through?";
      case "open_conversation":
        return "You seem to have a little space. Want to talk about what is on your mind?";
      default:
        return undefined;
    }
  }

  private score(presence: PresenceRecord | null): CompanionScore {
    const profile = this.profile(presence?.state ?? "unknown");
    const uncertainty = this.round(1 - (presence?.confidence ?? 0));
    const total = this.round(
      profile.relevance
      + profile.relationalContinuity
      + profile.urgency
      - profile.interruptionCost
      - profile.privacyRisk
      - uncertainty
    );
    return {
      ...profile,
      uncertainty,
      total,
      threshold: this.threshold
    };
  }

  private profile(state: PresenceState): StateScoreProfile {
    switch (state) {
      case "home":
        return {
          relevance: 0.75,
          relationalContinuity: 0.35,
          urgency: 0.1,
          interruptionCost: 0.15,
          privacyRisk: 0.05
        };
      case "available":
        return {
          relevance: 0.65,
          relationalContinuity: 0.35,
          urgency: 0.05,
          interruptionCost: 0.1,
          privacyRisk: 0.05
        };
      case "work":
        return {
          relevance: 0.45,
          relationalContinuity: 0.25,
          urgency: 0.05,
          interruptionCost: 0.55,
          privacyRisk: 0.05
        };
      case "focus":
        return {
          relevance: 0.2,
          relationalContinuity: 0.2,
          urgency: 0.05,
          interruptionCost: 0.95,
          privacyRisk: 0.05
        };
      case "transit":
        return {
          relevance: 0.3,
          relationalContinuity: 0.15,
          urgency: 0.05,
          interruptionCost: 0.8,
          privacyRisk: 0.35
        };
      case "away":
      case "unknown":
        return {
          relevance: 0,
          relationalContinuity: 0,
          urgency: 0,
          interruptionCost: 0.5,
          privacyRisk: 0.25
        };
    }
  }

  private validateHour(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      throw new Error(`${field} must be an integer between 0 and 23.`);
    }
  }

  private round(value: number): number {
    return Math.round(value * 1000) / 1000;
  }
}
