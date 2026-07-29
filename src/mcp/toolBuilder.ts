import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

export type ToolCategory =
  | "consult"
  | "memory"
  | "docs"
  | "web"
  | "identity"
  | "oracle"
  | "skill"
  | "session"
  | "util";

export interface ToolMetadata {
  category: ToolCategory;
  keywords?: string[];
  rateLimit?: { maxPerMin: number };
  cacheable?: boolean;
}

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  title: string;
  description: string;
  inputSchema: z.ZodType<any>;
  outputSchema: z.ZodType<any>;
  keywords?: string[];
  rateLimitPerMin?: number;
  cacheable?: boolean;
  handler: (input: any, extra?: any) => Promise<any>;
}

/**
 * Standard success/error response format for all tools
 */
const BaseOutput = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ToolOutput = z.infer<typeof BaseOutput>;

/**
 * Success response helper
 */
export function toolSuccess(data: any, metadata?: Record<string, any>): ToolOutput {
  return { success: true, data, metadata };
}

/**
 * Error response helper
 */
export function toolError(error: string, metadata?: Record<string, any>): ToolOutput {
  return { success: false, error, metadata };
}

/**
 * Tool registry builder — handles consistent registration
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  registerAll(server: McpServer): void {
    for (const [name, def] of this.tools) {
      server.registerTool(
        name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.inputSchema,
        },
        async (input, extra) => {
          try {
            const validated = await def.inputSchema.parseAsync(input);
            const result = await def.handler(validated, extra);
            const output = await def.outputSchema.parseAsync(result);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
              structuredContent: output as Record<string, unknown>,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              isError: true,
              content: [
                { type: "text" as const, text: JSON.stringify({ error: message }, null, 2) },
              ],
              structuredContent: { error: message } as Record<string, unknown>,
            };
          }
        }
      );
    }
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  byCategory(category: ToolCategory): ToolDefinition[] {
    return this.list().filter((t) => t.category === category);
  }
}
