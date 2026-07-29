import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Provider, ProviderRequest } from "./provider.js";
import type { ProviderResponse } from "../types.js";
import type { AgentMessage, AgentProvider, AgentTool, AgentTurn, ToolCall } from "../agent/types.js";
import type { DoctorCheck, ExecutionBackendCapabilities } from "../backends/backend.js";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

interface CommandEnvironment {
  platform: NodeJS.Platform;
  execPath: string;
  appData?: string;
}

export function resolveCommandInvocation(
  command: string,
  args: string[],
  environment: CommandEnvironment
): { command: string; args: string[] } {
  if (environment.platform !== "win32" || command !== "codex" || !environment.appData) {
    return { command, args };
  }
  return {
    command: environment.execPath,
    args: [
      path.join(
        environment.appData,
        "npm",
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js"
      ).replaceAll("\\", "/"),
      ...args
    ]
  };
}

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const invocation = resolveCommandInvocation(command, args, {
      platform: process.platform,
      execPath: process.execPath,
      appData: process.env.APPDATA
    });
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input);
  });

const CODEX_CAPABILITIES: ExecutionBackendCapabilities = {
  consult: true,
  toolUse: true,
  images: false,
  continuation: false,
  structuredUsage: false,
  supportedPlatforms: ["darwin", "linux", "win32"]
};

export class CodexCliProvider implements Provider, AgentProvider {
  readonly id = "codex";
  readonly capabilities = CODEX_CAPABILITIES;
  private readonly runner: CommandRunner;

  constructor(options: { runner?: CommandRunner } = {}) {
    this.runner = options.runner ?? runCommand;
  }

  async healthCheck(): Promise<DoctorCheck[]> {
    try {
      const version = await this.runner("codex", ["--version"], {});
      if (version.exitCode !== 0) {
        return [{ name: "codex executable", ok: false, detail: version.stderr.trim() }];
      }
      const login = await this.runner("codex", ["login", "status"], {});
      return [
        { name: "codex executable", ok: true, detail: version.stdout.trim() },
        {
          name: "codex authentication",
          ok: login.exitCode === 0,
          detail: (login.stdout || login.stderr).trim()
        }
      ];
    } catch (error) {
      return [
        {
          name: "codex executable",
          ok: false,
          detail: error instanceof Error ? error.message : String(error)
        }
      ];
    }
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    // ponytail: previousResponseId unsupported by Codex CLI, re-run fresh
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-codex-"));
    const outputPath = path.join(temporaryDirectory, "output.md");
    try {
      const result = await this.runner(
        "codex",
        [
          "exec",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--color",
          "never",
          "--cd",
          request.cwd,
          "--model",
          request.model,
          "--output-last-message",
          outputPath,
          "-"
        ],
        { input: `${request.systemPrompt}\n\n${request.userPrompt}`, cwd: request.cwd }
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Codex exited with code ${result.exitCode}.`);
      }
      const text = await fs.readFile(outputPath, "utf8");
      if (!text.trim()) throw new Error("Codex returned an empty response.");
      return { text: text.trim(), usage: {} };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  /** Runs one agentic turn via text-based tool calling through `codex exec`. */
  async runAgentTurn(params: {
    model: string;
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<AgentTurn> {
    // ── Format tool definitions ───────────────────────────────────────
    const toolDefs = params.tools.map((t) => {
      const props = t.inputSchema.properties
        ? Object.entries(t.inputSchema.properties as Record<string, unknown>)
            .map(([k, v]) => `  ${k}: ${(v as any).type}${(v as any).description ? ` — ${(v as any).description}` : ""}`)
            .join("\n")
        : "  (no parameters)";
      return `### ${t.name}\n${t.description}\nParameters:\n${props}`;
    }).join("\n\n");

    const toolNames = params.tools.map((t) => t.name).join(", ");

    const systemBlock = `${params.system}

AVAILABLE TOOLS:
${toolDefs}

To use a tool, end your response with a JSON code block:
\`\`\`tool
{"tool": "tool_name", "args": { "param": "value" } }
\`\`\`

Available tools: ${toolNames}
Only use tools from the list above. You can call at most one tool per turn.`;

    // ── Format conversation ───────────────────────────────────────────
    const lines: string[] = [];
    for (const m of params.messages) {
      if (m.role === "user") {
        const content = typeof m.content === "string" ? m.content : m.content.map((c) => c.type === "text" ? c.text : "").filter(Boolean).join("\n");
        lines.push(`## User\n${content}`);
      } else if (m.role === "assistant") {
        if (m.text) lines.push(`## Assistant\n${m.text}`);
        for (const tc of m.toolCalls) {
          lines.push(`\`\`\`tool\n${JSON.stringify({ tool: tc.name, args: tc.input })}\n\`\`\``);
        }
      } else if (m.role === "tool") {
        for (const r of m.results) {
          const text = r.content.map((c) => c.type === "text" ? c.text : "").filter(Boolean).join("\n");
          lines.push(`## Tool Result (${r.isError ? "ERROR" : "ok"})\n${text.slice(0, 5000)}`);
        }
      }
    }
    lines.push("## Assistant");

    const fullPrompt = `${systemBlock}\n\n${lines.join("\n\n")}`;

    // ── Call codex exec ─────────────────────────────────────────────
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-codex-agent-"));
    const outputPath = path.join(tempDir, "output.md");
    try {
      const result = await this.runner("codex", [
        "exec",
        "--sandbox", "read-only",
        "--ephemeral",
        "--color", "never",
        "--cd", ".",
        "--model", params.model,
        "--output-last-message", outputPath,
        "-"
      ], { input: fullPrompt });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Codex exited with code ${result.exitCode}.`);
      }

      const raw = await fs.readFile(outputPath, "utf8");
      const text = raw.trim();

      // ── Parse tool call from response ──────────────────────────────
      const toolMatch = text.match(/```tool\n(\{[\s\S]*?\n?)\n?```/);
      let toolCalls: ToolCall[] = [];

      if (toolMatch) {
        try {
          const parsed = JSON.parse(toolMatch[1].trim());
          if (parsed && typeof parsed === "object" && parsed.tool && parsed.args) {
            toolCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: String(parsed.tool),
              input: parsed.args as Record<string, unknown>,
            });
          }
        } catch {
          // Malformed JSON — treat as plain text
        }
      }

      // Strip the tool block from displayed text
      const cleanText = text.replace(/```tool\n[\s\S]*?\n```/g, "").trim();

      return {
        message: { role: "assistant", text: cleanText, toolCalls },
        usage: {},
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
