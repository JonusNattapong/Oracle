export const PRESENCE_STATES = [
  "home",
  "work",
  "transit",
  "focus",
  "available",
  "away",
  "unknown"
] as const;

export const PRESENCE_SOURCES = [
  "manual",
  "device",
  "calendar",
  "geofence"
] as const;

export type PresenceState = typeof PRESENCE_STATES[number];
export type PresenceSource = typeof PRESENCE_SOURCES[number];
export type CompanionIntentAction = "speak" | "silence";
export type CompanionIntentTrigger = "presence_update" | "manual";

export interface PresenceRecord {
  id: string;
  state: PresenceState;
  source: PresenceSource;
  confidence: number;
  observedAt: string;
  expiresAt: string;
  createdAt: string;
}

export interface UpdatePresenceInput {
  state: PresenceState;
  source?: PresenceSource;
  confidence?: number;
  observedAt?: string;
  ttlMinutes?: number;
}

export interface CompanionScore {
  relevance: number;
  relationalContinuity: number;
  urgency: number;
  interruptionCost: number;
  privacyRisk: number;
  uncertainty: number;
  total: number;
  threshold: number;
}

export interface CompanionIntent {
  id: string;
  presenceId?: string;
  trigger: CompanionIntentTrigger;
  candidate: "welcome_home" | "check_in" | "open_conversation" | "stay_silent";
  action: CompanionIntentAction;
  message?: string;
  reason: string;
  score: CompanionScore;
  createdAt: string;
}

export interface CompanionPauseState {
  paused: boolean;
  pausedAt?: string;
  pausedUntil?: string;
}

export interface CompanionSettings {
  quietHours: {
    startHour: number;
    endHour: number;
  };
  threshold: number;
  pause: CompanionPauseState;
}

export interface CompanionStateSnapshot {
  generatedAt: string;
  presence: PresenceRecord | null;
  presenceActive: boolean;
  settings: CompanionSettings;
  recentIntents: CompanionIntent[];
}

export interface PresenceUpdateResult {
  presence: PresenceRecord;
  intent: CompanionIntent;
}

export const DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
  "suppressed"
] as const;

export type DeliveryStatus = typeof DELIVERY_STATUSES[number];

/**
 * Why a delivery attempt failed, classified into a closed set so replayable
 * events never carry host paths, commands, or other environment detail.
 */
export type DeliveryErrorKind =
  | "unavailable"
  | "spawn_failed"
  | "timeout"
  | "exit_code";

export interface CompanionDelivery {
  id: string;
  intentId: string;
  channel: string;
  status: DeliveryStatus;
  attempts: number;
  /** Suppression reason or sanitized failure summary. Local-only. */
  detail?: string;
  createdAt: string;
  attemptedAt?: string;
  deliveredAt?: string;
}

export interface DeliveryResult {
  delivered: boolean;
  errorKind?: DeliveryErrorKind;
  /** Short, sanitized detail retained locally; never published to events. */
  detail?: string;
}

export interface CompanionChannelStatus {
  channel: string;
  enabled: boolean;
  available: boolean;
  /** Why the channel cannot deliver, when it is unavailable. */
  reason?: string;
}

/**
 * A notification channel. CompanionService and CompanionDeliveryService stay
 * platform-agnostic; only implementations of this interface touch the OS.
 */
export interface CompanionNotifier {
  readonly channel: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly unavailableReason?: string;
  deliver(intent: CompanionIntent): Promise<DeliveryResult>;
}
