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
