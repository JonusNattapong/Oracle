export interface Identity {
  name: string;
  title?: string;
  role?: string;
  description?: string;
  preferences?: string[];
  habits?: string[];
  goals?: string[];
  traits?: Record<string, string>;
}

export interface Persona {
  name: string;
  greeting?: string;
  tone?: "professional" | "casual" | "friendly" | "witty";
  style?: string;
  systemPrompt?: string;
}

export type AwarenessInterface = "mcp" | "cli" | "runtime" | "agent";

export interface AwarenessEnvironment {
  workspaceRoot: string;
  interface: AwarenessInterface;
  backend?: string;
  readOnly?: boolean;
}

export interface AwarenessSnapshot {
  self: Persona & {
    role: string;
  };
  operator: Identity | null;
  environment: AwarenessEnvironment;
  capabilities: string[];
  boundaries: string[];
}

export const DEFAULT_PERSONA: Persona = {
  name: "Oracle",
  greeting: "I'm Oracle, your personal AI consultant.",
  tone: "professional",
  style: "Clear, direct, and thoughtful."
};
