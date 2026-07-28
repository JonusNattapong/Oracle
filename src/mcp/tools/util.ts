import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectConfig } from "../../config/project.js";
import { serializeOracleError } from "../../errors.js";
import { checkProvider, parseProviderName } from "../../providers/factory.js";

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

export function registerUtilTool(
  server: McpServer,
  deps: {
    config: ProjectConfig;
    workspaceRoot: string;
    providerId: string;
    providerChecks?: typeof checkProvider;
  }
): void {
  const providerChecks = deps.providerChecks ?? checkProvider;

  server.registerTool(
    "oracle_doctor",
    {
      title: "Check Oracle",
      description: "Check project config, provider health, and workspace setup.",
      inputSchema: {}
    },
    async () => {
      try {
        const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
        const sessionProbe = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-doctor-"));
        await fs.rm(sessionProbe, { recursive: true, force: true });
        await fs.access(deps.workspaceRoot, fs.constants.R_OK);
        const checks = [
          {
            name: "node runtime",
            ok: nodeMajor >= 24,
            detail: `Node.js ${process.versions.node}; requires 24 or newer`
          },
          { name: "project configuration", ok: true, detail: `${deps.providerId}/${deps.config.model}` },
          { name: "workspace readable", ok: true, detail: deps.workspaceRoot },
          { name: "session storage writable", ok: true, detail: os.tmpdir() },
          ...(await providerChecks(parseProviderName(deps.providerId)))
        ];
        return success(JSON.stringify(checks, null, 2), {
          healthy: checks.every((check) => check.ok),
          checks
        });
      } catch (error) {
        return failure(error);
      }
    }
  );
}
