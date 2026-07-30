/**
 * Neutral, provider-agnostic types for Oracle's agentic tool-use loop.
 *
 * The loop keeps its conversation in this neutral shape; each AgentProvider
 * translates to/from its own wire format (Anthropic tool_use blocks, OpenAI
 * function calls, etc.). This keeps the loop and the tools independent of any
 * single provider so new backends can be added without touching either.
 */

/** JSON-schema fragment describing a tool's input, as sent to the model. */
export type JsonSchema = Record<string, unknown>;

/** A single tool invocation the model asked for. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Multimodal content block. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "video"; mimeType: string; data: string };

/** The result of executing one ToolCall, fed back to the model. */
export interface ToolResult {
  id: string;
  content: ContentBlock[];
  isError?: boolean;
}

/** Neutral conversation message. */
export type AgentMessage =
  | { role: "user"; content: ContentBlock[] | string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

/** One assistant turn: any text it produced plus any tools it wants to run. */
export interface AgentTurn {
  /** The assistant message to append to the transcript verbatim. */
  message: Extract<AgentMessage, { role: "assistant" }>;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Context handed to every tool executor. */
export interface AgentContext {
  /** Absolute workspace root; tools must not touch anything outside it. */
  workspaceRoot: string;
  /** When true, write/edit tools refuse to run (analysis-only mode). */
  readOnly: boolean;
  /** Optional audit trail to record file mutations. */
  audit?: any; // AuditTrail type, avoid circular import
  /** Optional zero-trust policy; when absent, no policy checks are enforced. */
  policy?: import("./policy.js").OraclePolicy;
  /** Shared command executor; Docker mode is fail-closed and never falls back to host execution. */
  sandbox?: import("../sandbox/runner.js").SandboxRunner;
}

/** A tool the agent can call: its schema (for the model) + executor. */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Mutates the workspace or runs commands; gated by AgentContext.readOnly. */
  mutating: boolean;
  execute(input: Record<string, unknown>, ctx: AgentContext): Promise<string | ContentBlock[]>;
}

/** Provider capability for running one agentic turn with tools available. */
export interface AgentProvider {
  readonly id: string;
  runAgentTurn(params: {
    model: string;
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<AgentTurn>;
}
