/**
 * Autonomous Task Breakdown & Verification Generation Engine
 * Decomposes high-level prompts into actionable sub-tasks with verification checklists.
 */

export interface TaskBreakdownItem {
  title: string;
  description: string;
  assignee: string;
  checklist: string[];
}

export interface BreakdownOptions {
  createdBy?: string;
  defaultAssignee?: string;
  workflowId?: string;
}

/**
 * Decomposes a high-level goal string into structured sub-tasks with verification checklists.
 */
export function breakdownGoal(goal: string, options: BreakdownOptions = {}): TaskBreakdownItem[] {
  const normalizedGoal = goal.trim();
  const defaultAssignee = options.defaultAssignee || "coder";
  const tasks: TaskBreakdownItem[] = [];

  const lower = normalizedGoal.toLowerCase();

  // Detect key domains in the goal
  const hasRateLimit = lower.includes("rate limit") || lower.includes("throttling");
  const hasAuth = lower.includes("auth") || lower.includes("login") || lower.includes("jwt");
  const hasApi = lower.includes("api") || lower.includes("endpoint");
  const hasDocs = lower.includes("doc") || lower.includes("readme");
  const hasRefactor = lower.includes("refactor") || lower.includes("clean");

  // 1. Architecture / Interface Design Phase
  tasks.push({
    title: `Design & Interface Spec: ${normalizedGoal.slice(0, 50)}`,
    description: `Outline type definitions, configuration schemas, and interfaces required for: ${normalizedGoal}`,
    assignee: "architect",
    checklist: [
      "Define component interfaces & type definitions",
      "Verify backwards compatibility with existing API surface",
      "Draft implementation proposal"
    ]
  });

  // 2. Core Implementation Phase
  if (hasRateLimit || hasAuth || hasApi || !hasDocs) {
    tasks.push({
      title: `Implementation: ${normalizedGoal.slice(0, 50)}`,
      description: `Implement core logic, middleware, and business rules for: ${normalizedGoal}`,
      assignee: defaultAssignee,
      checklist: [
        "Implement core module & business logic",
        "Enforce safety boundaries & input validation",
        "Integrate module into primary execution pipeline"
      ]
    });
  }

  // 3. Verification & Testing Phase
  tasks.push({
    title: `Verification & Test Suite: ${normalizedGoal.slice(0, 50)}`,
    description: `Create automated unit/integration tests and verify release gate for: ${normalizedGoal}`,
    assignee: "tester",
    checklist: [
      "Write unit/integration tests covering happy paths & edge cases",
      "Verify test suite passes cleanly (`npm test`)",
      "Verify release gate builds without errors (`npm run verify`)"
    ]
  });

  // 4. Documentation Phase
  if (hasDocs || tasks.length > 0) {
    tasks.push({
      title: `Documentation & Guide: ${normalizedGoal.slice(0, 50)}`,
      description: `Update user-facing README, API references, and inline docstrings for: ${normalizedGoal}`,
      assignee: "docs",
      checklist: [
        "Update README.md / API documentation",
        "Add JSDoc/inline comments to exported symbols",
        "Verify doc links and code examples"
      ]
    });
  }

  return tasks;
}
