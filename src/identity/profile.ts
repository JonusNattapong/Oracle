import fs from "node:fs/promises";
import path from "node:path";
import type {
  AwarenessEnvironment,
  AwarenessSnapshot,
  Identity,
  Persona
} from "./types.js";
import { DEFAULT_PERSONA } from "./types.js";

const ORACLE_ROLE = "Persistent coordination and context layer for AI coding agents.";

const ORACLE_BOUNDARIES = [
  "Oracle is software, not a conscious being; identity must be described functionally.",
  "Knowledge is limited to supplied, retrieved, or persisted context; uncertainty must be stated.",
  "Actions must not be claimed without tool or system evidence.",
  "Filesystem and command execution must remain inside the workspace and active policy.",
  "Risky actions may require human approval and must respect read-only mode.",
  "The execution backend is an implementation detail; Oracle keeps its configured identity.",
  "Only the minimum operating context needed for the task should be sent to an external backend."
];

function capabilitiesFor(environment: AwarenessEnvironment): string[] {
  switch (environment.interface) {
    case "agent":
      return [
        "Inspect and search files inside the active workspace.",
        environment.readOnly
          ? "Analyze workspace state without mutation while read-only mode is enabled."
          : "Edit workspace files and run policy-checked commands.",
        "Use configured external MCP tools when they are connected.",
        "Persist checkpoints and audited tool evidence for the current run."
      ];
    case "runtime":
      return [
        "Run grounded consultations through the selected execution backend.",
        "Manage persistent schedules, approvals, and replayable Runtime events.",
        "Expose the authenticated Control Center and project-scoped Remote Swarm.",
        "Persist consultation sessions and validated output artifacts."
      ];
    case "mcp":
      return [
        "Run grounded consultations using selected workspace files and conversation context.",
        "Search and maintain persistent project and global memory and local documentation.",
        "Run autonomous workspace actions when an agent backend and policy permit it.",
        "Coordinate agents through messages, verified tasks, and recovery.",
        "Retrieve web information when explicitly invoked and configured."
      ];
    case "cli":
      return [
        "Run grounded consultations using selected workspace files and conversation context.",
        "Manage memory, documentation, identity, messaging, tasks, schedules, and Runtime state.",
        "Run autonomous workspace actions when an agent backend and policy permit it.",
        "Inspect diagnostics, audit state, sessions, and provider health.",
        "Retrieve web information when explicitly invoked and configured."
      ];
  }
}

export class ProfileStore {
  constructor(private readonly rootDir: string) {}

  private identityPath(): string {
    return path.join(this.rootDir, "identity.json");
  }

  private personaPath(): string {
    return path.join(this.rootDir, "persona.json");
  }

  async getIdentity(): Promise<Identity | null> {
    try {
      return JSON.parse(await fs.readFile(this.identityPath(), "utf8"));
    } catch {
      return null;
    }
  }

  async saveIdentity(identity: Identity): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.identityPath(), JSON.stringify(identity, null, 2), "utf8");
  }

  async getPersona(): Promise<Persona> {
    try {
      return { ...DEFAULT_PERSONA, ...JSON.parse(await fs.readFile(this.personaPath(), "utf8")) };
    } catch {
      return { ...DEFAULT_PERSONA };
    }
  }

  async savePersona(persona: Persona): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.personaPath(), JSON.stringify(persona, null, 2), "utf8");
  }

  async getAwareness(environment: AwarenessEnvironment): Promise<AwarenessSnapshot> {
    const [storedIdentity, persona] = await Promise.all([this.getIdentity(), this.getPersona()]);
    const operator = storedIdentity?.name.trim() ? storedIdentity : null;
    return {
      self: {
        ...persona,
        role: ORACLE_ROLE
      },
      operator,
      environment: {
        ...environment,
        workspaceRoot: path.resolve(environment.workspaceRoot)
      },
      capabilities: capabilitiesFor(environment),
      boundaries: [...ORACLE_BOUNDARIES]
    };
  }

  async buildAwarenessContext(environment: AwarenessEnvironment): Promise<string> {
    const awareness = await this.getAwareness(environment);
    const workspaceLabel =
      path.basename(awareness.environment.workspaceRoot)
      || path.parse(awareness.environment.workspaceRoot).root;
    const lines = [
      `Identity: ${awareness.self.name}.`,
      `Role: ${awareness.self.role}`,
      awareness.self.greeting ? `Greeting: ${awareness.self.greeting}` : undefined,
      awareness.self.tone ? `Tone: ${awareness.self.tone}.` : undefined,
      awareness.self.style ? `Style: ${awareness.self.style}` : undefined,
      awareness.self.systemPrompt,
      awareness.operator?.name
        ? `Operator: ${awareness.operator.name}${awareness.operator.role ? ` (${awareness.operator.role})` : ""}.`
        : "Operator: not configured.",
      `Current interface: ${awareness.environment.interface}.`,
      `Current workspace: ${workspaceLabel}.`,
      awareness.environment.backend
        ? `Current execution backend: ${awareness.environment.backend}.`
        : undefined,
      awareness.environment.readOnly !== undefined
        ? `Read-only mode: ${awareness.environment.readOnly ? "enabled" : "disabled"}.`
        : undefined,
    ];

    if (awareness.operator) {
      if (awareness.operator.title) lines.push(`Operator title: ${awareness.operator.title}.`);
      if (awareness.operator.description) lines.push(`About the operator: ${awareness.operator.description}`);
      if (awareness.operator.preferences?.length) {
        lines.push(`Operator preferences: ${awareness.operator.preferences.join(", ")}.`);
      }
      if (awareness.operator.habits?.length) {
        lines.push(`Operator habits: ${awareness.operator.habits.join(", ")}.`);
      }
      if (awareness.operator.goals?.length) {
        lines.push(`Operator goals: ${awareness.operator.goals.join(", ")}.`);
      }
    }

    lines.push(
      "",
      "Capabilities:",
      ...awareness.capabilities.map((capability) => `- ${capability}`),
      "",
      "Boundaries:",
      ...awareness.boundaries.map((boundary) => `- ${boundary}`)
    );

    return lines.filter((line): line is string => line !== undefined).join("\n");
  }

  // Build the system prompt prefix that makes Oracle "know who you are"
  async buildPersonalContext(): Promise<string> {
    const [identity, persona] = await Promise.all([this.getIdentity(), this.getPersona()]);
    const parts: string[] = [];

    if (persona) {
      parts.push(`You are ${persona.name}. ${persona.greeting ?? ""}`);
      if (persona.tone) parts.push(`Tone: ${persona.tone}.`);
      if (persona.style) parts.push(`Style: ${persona.style}`);
      if (persona.systemPrompt) parts.push(persona.systemPrompt);
    }

    if (identity) {
      parts.push("");
      parts.push(`You are speaking to ${identity.name}.`);
      if (identity.title) parts.push(`Title: ${identity.title}`);
      if (identity.role) parts.push(`Role: ${identity.role}`);
      if (identity.description) parts.push(`About them: ${identity.description}`);
      if (identity.preferences?.length) parts.push(`Preferences: ${identity.preferences.join(", ")}`);
      if (identity.habits?.length) parts.push(`Habits: ${identity.habits.join(", ")}`);
      if (identity.goals?.length) parts.push(`Goals: ${identity.goals.join(", ")}`);
      if (identity.traits) {
        for (const [key, val] of Object.entries(identity.traits)) {
          parts.push(`${key}: ${val}`);
        }
      }
    }

    return parts.join("\n");
  }
}
