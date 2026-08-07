import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ConsultService } from "../../core/consult.js";
import type { ProjectConfig } from "../../config/project.js";
import type { PRFile } from "../../github/types.js";
import * as gh from "../../github/gh.js";
import { success, failure } from "../response.js";

export function registerGitHubTools(
  server: McpServer,
  deps: {
    workspaceRoot: string;
    service: ConsultService;
    providerId: string;
    config: ProjectConfig;
  }
): void {
  server.registerTool(
    "oracle_github_pr_get",
    {
      title: "Get PR Details",
      description: "Get PR details.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        const pr = gh.getPR(number, r);
        return success(JSON.stringify(pr, null, 2), pr as unknown as Record<string, unknown>);
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_list",
    {
      title: "List PRs",
      description: "List pull requests with filters.",
      inputSchema: {
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote"),
        state: z.enum(["open", "closed", "merged", "all"]).default("open"),
        limit: z.number().int().min(1).max(100).default(30),
        base: z.string().optional(),
        head: z.string().optional(),
        author: z.string().optional(),
        labels: z.string().optional().describe("comma-separated")
      }
    },
    async ({ repo, state, limit, base, head, author, labels }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        const prs = gh.listPRs({ repo: r, state, limit, base, head, author, labels: labels?.split(",") });
        return success(JSON.stringify(prs, null, 2), { count: prs.length, prs: prs as unknown as Record<string, unknown>[] });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_diff",
    {
      title: "Get PR Diff",
      description: "Get the full PR diff.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        const diff = gh.getPRDiff(number, r);
        return success(diff, { number, diffLength: diff.length });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_files",
    {
      title: "Get PR Files",
      description: "List changed files in a PR.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        const files = gh.getPRFiles(number, r);
        return success(JSON.stringify(files, null, 2), { count: files.length, files: files as unknown as Record<string, unknown>[] });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_review",
    {
      title: "Review PR",
      description: "Review a PR (analysis only — use oracle_github_pr_review_submit to post).",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        const pr = gh.getPR(number, r);
        const diff = gh.getPRDiff(number, r);
        const files = gh.getPRFiles(number, r);
        const fileList = files.map((f: PRFile) => `  ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`).join("\n");
        const reviewPrompt = [
          `## PR Review: #${number} — ${pr.title}`,
          `**Author:** ${pr.author}  **Repo:** ${r}`,
          `**Base:** ${pr.baseRef} ← **Head:** ${pr.headRef}`,
          "",
          pr.body ? `### Description\n${pr.body}\n` : "",
          `### Changed Files (${files.length})`,
          fileList,
          "",
          "### Diff",
          "```diff",
          diff.slice(0, 50000),
          "```",
          "",
          "Review this PR for correctness, edge cases, security, and maintainability.",
          "Be specific — cite line numbers from the diff. Categorize findings by severity (critical/major/minor/nit).",
        ].filter(Boolean).join("\n");

        const result = await deps.service.consult({
          prompt: reviewPrompt,
          preset: "review",
          provider: deps.providerId,
          model: deps.config.model,
          cwd: deps.workspaceRoot,
          systemPrompt: "You are a senior code reviewer. Analyze the PR diff and files. Be specific, cite line numbers, and categorize findings by severity (critical/major/minor/nit). End with a verdict: approve, request changes, or comment."
        });

        return success(result.output, {
          sessionId: result.sessionId,
          prNumber: number,
          repo: r,
          files: files.length,
          diffBytes: diff.length
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_pr_review_submit",
    {
      title: "Submit PR Review",
      description: "Submit a PR review (APPROVE, REQUEST_CHANGES, or COMMENT).",
      inputSchema: {
        number: z.number().int().positive(),
        body: z.string().describe("Review body text"),
        event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).default("COMMENT"),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, body, event, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        gh.submitPRReview(number, body, event, r);
        return success(`Review submitted on PR #${number}`, { number, event, repo: r });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_issue_get",
    {
      title: "Get Issue",
      description: "Get issue details.",
      inputSchema: {
        number: z.number().int().positive(),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        const issue = gh.getIssue(number, r);
        return success(JSON.stringify(issue, null, 2), issue as unknown as Record<string, unknown>);
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_issue_list",
    {
      title: "List Issues",
      description: "List issues with filters.",
      inputSchema: {
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote"),
        state: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().int().min(1).max(100).default(30),
        author: z.string().optional(),
        labels: z.string().optional().describe("comma-separated")
      }
    },
    async ({ repo, state, limit, author, labels }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        const issues = gh.listIssues({ repo: r, state, limit, author, labels: labels?.split(",") });
        return success(JSON.stringify(issues, null, 2), { count: issues.length, issues: issues as unknown as Record<string, unknown>[] });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_comment",
    {
      title: "Create GitHub Comment",
      description: "Comment on an issue or PR.",
      inputSchema: {
        number: z.number().int().positive(),
        body: z.string().min(1),
        repo: z.string().optional().describe("owner/repo, defaults to inferred from git remote")
      }
    },
    async ({ number, body, repo }) => {
      try {
        const r = repo ?? gh.inferRepo(deps.workspaceRoot);
        gh.createComment(number, body, r);
        return success(`Comment posted on #${number}`, { number, repo: r });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_search",
    {
      title: "Search GitHub Code",
      description: "Search code across GitHub repos.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10)
      }
    },
    async ({ query, limit }) => {
      try {
        const results = gh.searchCode(query, limit);
        return success(JSON.stringify(results, null, 2), { count: results.length, results: results as unknown as Record<string, unknown>[] });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_github_api",
    {
      title: "GitHub API",
      description: "Raw GitHub API GET request via gh CLI.",
      inputSchema: {
        endpoint: z.string().min(1).describe("e.g. /repos/owner/repo/pulls")
      }
    },
    async ({ endpoint }) => {
      try {
        const data = gh.apiRequest(endpoint);
        return success(JSON.stringify(data, null, 2), { endpoint });
      } catch (error) { return failure(error); }
    }
  );
}
