import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { serializeOracleError } from "../../errors.js";
import type { OracleRegistry } from "../../oracles/registry.js";

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

export function registerOracleProfileTools(server: McpServer, oracles: OracleRegistry): void {
  server.registerTool(
    "oracle_oracle_list",
    {
      title: "List Oracles",
      description: "List registered oracle profiles.",
      inputSchema: {}
    },
    async () => {
      try {
        const list = await oracles.listOracles();
        return success(JSON.stringify(list, null, 2), { oracles: list });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_oracle_register",
    {
      title: "Register Oracle",
      description: "Create a named oracle profile with a skill.",
      inputSchema: {
        name: z.string().min(1),
        skill: z.string().min(1),
        description: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        memory: z.boolean().optional()
      }
    },
    async (params) => {
      try {
        await oracles.registerOracle({
          name: params.name,
          skill: params.skill,
          description: params.description,
          model: params.model,
          provider: params.provider,
          memory: params.memory
        });
        return success(`Registered oracle: ${params.name}`, { name: params.name });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_init",
    {
      title: "Initialize Workspace",
      description: "Bootstrap .oracle/ with policy, config, docs, and skills.",
      inputSchema: {
        force: z.boolean().optional().default(false),
      }
    },
    async ({ force }) => {
      try {
        const workspaceRoot = process.cwd();
        const oracleDir = path.join(workspaceRoot, ".oracle");
        await fs.mkdir(oracleDir, { recursive: true });
        await fs.mkdir(path.join(oracleDir, "docs"), { recursive: true });
        await fs.mkdir(path.join(oracleDir, "skills"), { recursive: true });

        const defaultPolicy = {
          forbiddenGlobs: [".env", ".env.", "id_rsa", "id_ed25519", ".pem", "credentials.json", ".oracle/policy.json"],
          forbiddenCommands: ["rm -rf /", "rm -rf c:", "rm -rf c:\\", "mkfs", "dd if=", ":(){ :|:& };:"],
          maxMutationsPerSession: 50,
        };
        const defaultConfig = {
          provider: "codex",
          model: "gpt-5.4",
          include: ["src/**/*", "README.md", "package.json"],
          exclude: ["**/*.test.ts", "**/node_modules/**", "**/dist/**", "**/build/**"],
          maxFileSizeBytes: 1000000,
          maxInputBytes: 5000000,
        };

        const created: string[] = [];

        const writeIf = async (p: string, data: Record<string, unknown>, label: string) => {
          try {
            await fs.readFile(p, "utf8");
            if (force) { await fs.writeFile(p, `${JSON.stringify(data, null, 2)}\n`, "utf8"); created.push(label + " (overwritten)"); }
            else created.push(label + " (exists)");
          } catch {
            await fs.writeFile(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
            created.push(label);
          }
        };

        await writeIf(path.join(oracleDir, "policy.json"), defaultPolicy, "policy.json");
        await writeIf(path.join(oracleDir, "config.json"), defaultConfig, "config.json");
        created.push("docs/");
        created.push("skills/");

        return success(`Initialized .oracle/ in ${workspaceRoot}`, { created, workspaceRoot });
      } catch (error) { return failure(error); }
    }
  );
}
