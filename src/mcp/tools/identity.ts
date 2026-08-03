import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serializeOracleError } from "../../errors.js";
import { ProfileStore } from "../../identity/profile.js";
import type { AwarenessEnvironment } from "../../identity/types.js";

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

}
