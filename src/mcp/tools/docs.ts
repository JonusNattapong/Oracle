import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { success, failure } from "../response.js";
import { listDocs, searchDocs, addDoc, removeDoc } from "../../docs/reader.js";

export function registerDocsTools(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "oracle_docs_search",
    {
      title: "Search Docs",
      description:
        "BM25 search over .oracle/docs/, chunked by heading. Omit `query` to list the "
        + "available documents instead.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Omit to list documents rather than search"),
        limit: z.number().int().min(1).max(20).default(5),
      }
    },
    async ({ query, limit }) => {
      try {
        if (!query) {
          const docs = await listDocs(workspaceRoot);
          const summary = docs.map((d) => ({ name: d.name, size: d.size }));
          return success(JSON.stringify(summary, null, 2), {
            mode: "list", count: docs.length, docs: summary
          });
        }
        const results = await searchDocs(workspaceRoot, query, limit);
        return success(JSON.stringify(results, null, 2), {
          mode: "search", count: results.length, results
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_docs_add",
    {
      title: "Add Doc",
      description: "Add a file to .oracle/docs/. Supports .md, .txt, .json, .mdx.",
      inputSchema: {
        name: z.string().min(1).describe("Relative filename, e.g. 'auth/oauth.md'"),
        content: z.string()
      }
    },
    async ({ name, content }) => {
      try {
        const filePath = await addDoc(workspaceRoot, name, content);
        return success(`Added ${name}`, { path: filePath });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_docs_remove",
    {
      title: "Remove Doc",
      description: "Delete a file from .oracle/docs/.",
      inputSchema: { name: z.string().min(1) }
    },
    async ({ name }) => {
      try {
        const removed = await removeDoc(workspaceRoot, name);
        if (!removed) return failure(new Error(`Doc not found: ${name}`));
        return success(`Removed ${name}`, { name });
      } catch (error) { return failure(error); }
    }
  );
}
