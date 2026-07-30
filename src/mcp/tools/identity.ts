import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serializeOracleError } from "../../errors.js";
import { ProfileStore } from "../../identity/profile.js";
import type { AwarenessEnvironment } from "../../identity/types.js";

function stringOrStringArray() {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (Array.isArray(value)) return value;
      return value
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    });
}

function success(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>
  };
}

export function registerIdentityTools(
  server: McpServer,
  profile: ProfileStore,
  environment: AwarenessEnvironment
): void {
  server.registerTool(
    "oracle_identity_show",
    {
      title: "Show Identity",
      description: "Show identity profile and Oracle's persona.",
      inputSchema: {}
    },
    async () => {
      try {
        const identity = await profile.getIdentity();
        const persona = await profile.getPersona();
        const awareness = await profile.getAwareness(environment);
        return success(
          JSON.stringify({ identity, persona, awareness }, null, 2),
          { identity, persona, awareness }
        );
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_awareness_show",
    {
      title: "Show Self-Awareness",
      description: "Show Oracle's derived identity, operator context, current environment, capabilities, and boundaries.",
      inputSchema: {}
    },
    async () => {
      try {
        const awareness = await profile.getAwareness(environment);
        return success(JSON.stringify(awareness, null, 2), awareness as unknown as Record<string, unknown>);
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_identity_setup",
    {
      title: "Set Identity",
      description: "Set up your identity profile.",
      inputSchema: {
        name: z.string().min(1),
        title: z.string().optional(),
        role: z.string().optional(),
        description: z.string().optional(),
        preferences: stringOrStringArray(),
        habits: stringOrStringArray(),
        goals: stringOrStringArray()
      }
    },
    async (params) => {
      try {
        await profile.saveIdentity({
          name: params.name,
          title: params.title,
          role: params.role,
          description: params.description,
          preferences: params.preferences,
          habits: params.habits,
          goals: params.goals
        });
        return success(`Identity saved for ${params.name}.`, { name: params.name });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_persona_set",
    {
      title: "Set Persona",
      description: "Set Oracle's voice and personality.",
      inputSchema: {
        name: z.string().default("Oracle"),
        tone: z.enum(["professional", "casual", "friendly", "witty"]).default("professional"),
        style: z.string().optional(),
        greeting: z.string().optional()
      }
    },
    async (params) => {
      try {
        await profile.savePersona({
          name: params.name,
          tone: params.tone as any,
          style: params.style,
          greeting: params.greeting
        });
        return success(`Persona saved: ${params.name}`, { name: params.name });
      } catch (error) { return failure(error); }
    }
  );
}
