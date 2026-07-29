import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ConsultService } from "../../core/consult.js";
import { OracleError, serializeOracleError } from "../../errors.js";

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

export function registerSessionTools(server: McpServer, service: ConsultService): void {
  server.registerTool(
    "oracle_sessions",
    {
      title: "List Oracle Sessions",
      description: "List recent consultations without full source content.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) }
    },
    async ({ limit }) => {
      try {
        const records = await service.listSessions(limit);
        const sessions = records.map((record) => ({
          sessionId: record.sessionId,
          status: record.status,
          model: record.model,
          provider: record.provider,
          preset: record.preset,
          createdAt: record.createdAt,
          completedAt: record.completedAt,
          fileCount: record.files.length,
          prompt: record.prompt.length > 120 ? `${record.prompt.slice(0, 117)}...` : record.prompt
        }));
        return success(JSON.stringify(sessions, null, 2), { sessions });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "oracle_session_get",
    {
      title: "Get Oracle Session",
      description: "Get a session's metadata and model output.",
      inputSchema: { sessionId: z.string().regex(/^[a-z0-9-]+-[a-f0-9]{8}$/) }
    },
    async ({ sessionId }) => {
      try {
        const record = await service.session(sessionId);
        if (!record) {
          throw new OracleError(
            "ORACLE_SESSION_NOT_FOUND",
            `Session not found: ${sessionId}`,
            "Call oracle_sessions to discover available session IDs."
          );
        }
        const { bundlePath: _bundlePath, ...safeRecord } = record;
        return success(record.output || JSON.stringify(safeRecord, null, 2), safeRecord);
      } catch (error) {
        return failure(error);
      }
    }
  );
}
