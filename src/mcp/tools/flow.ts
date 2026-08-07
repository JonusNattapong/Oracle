import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { FlowDeps, FlowMode, ResearchMode } from "../pipeline/flow.js";
import { runFlow } from "../pipeline/flow.js";

export function registerFlowTool(server: McpServer, deps: FlowDeps): void {
  server.registerTool(
    "oracle_run",
    {
      title: "Run Oracle Flow",
      description:
        "Use one entry point for consultation, research, planning, and workspace actions. "
        + "Auto mode plans mutation requests first; pass confirm=true only after reviewing the plan.",
      inputSchema: {
        prompt: z.string().min(1).max(50000).describe("The question, research request, plan, or task"),
        mode: z
          .enum(["auto", "consult", "research", "plan", "act"])
          .optional()
          .default("auto")
          .describe("Flow mode. Auto classifies the request; act requires confirm=true."),
        research: z
          .enum(["web-search", "deep-research"])
          .optional()
          .default("web-search")
          .describe("Research method when mode is research."),
        confirm: z
          .boolean()
          .optional()
          .default(false)
          .describe("Explicitly approve handing an action task to the agent backend."),
        backend: z.string().optional().describe("Consult backend override for read-only stages."),
        files: z.array(z.string().min(1)).max(200).optional(),
        include_docs: z.boolean().optional().default(false),
        include_memory: z.boolean().optional().default(true),
        conversation_id: z.string().optional(),
        max_steps: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({
      prompt,
      mode = "auto",
      research = "web-search",
      confirm = false,
      backend,
      files,
      include_docs,
      include_memory,
      conversation_id,
      max_steps,
    }) => runFlow(
      {
        prompt,
        mode: mode as FlowMode,
        research: research as ResearchMode,
        confirm,
        backend,
        files,
        includeDocs: include_docs,
        includeMemory: include_memory,
        conversationId: conversation_id,
        maxSteps: max_steps,
      },
      deps,
    ),
  );
}
