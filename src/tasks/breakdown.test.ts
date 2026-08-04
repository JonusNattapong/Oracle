import { describe, test, expect } from "vitest";
import { breakdownGoal } from "./breakdown.js";

describe("Autonomous Task Breakdown", () => {
  test("decomposes a high-level goal into structured sub-tasks with checklists", () => {
    const goal = "Implement Rate Limiting and update documentation";
    const subtasks = breakdownGoal(goal, { defaultAssignee: "coder" });

    expect(subtasks.length).toBeGreaterThanOrEqual(3);
    expect(subtasks[0].title).toContain("Design");
    expect(subtasks[1].title).toContain("Implementation");
    expect(subtasks[2].title).toContain("Verification");

    // Each subtask must have non-empty verification checklist items
    for (const task of subtasks) {
      expect(task.checklist.length).toBeGreaterThan(0);
      expect(task.assignee).toBeTruthy();
    }
  });
});
