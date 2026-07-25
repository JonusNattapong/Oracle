import { describe, expect, test } from "vitest";
import {
  applyFilter,
  cancelInput,
  clampSelection,
  createInitialState,
  filterApprovals,
  getSelection,
  moveSelection,
  switchTab,
  transitionConfirm,
  transitionFilter,
  transitionReject,
  type TuiState
} from "./ink-state.js";

const TAB_COUNT = 7;

function freshState(): TuiState {
  return createInitialState(TAB_COUNT);
}

describe("createInitialState", () => {
  test("starts on tab 0 with normal mode", () => {
    const s = freshState();
    expect(s.tab).toBe(0);
    expect(s.mode.type).toBe("normal");
    expect(s.filter).toBe("");
    expect(s.details).toBe(false);
    expect(s.connection).toBe("polling");
  });
});

describe("getSelection / clampSelection", () => {
  test("initial selection is 0 with scroll 0", () => {
    const s = freshState();
    const sel = getSelection(s);
    expect(sel.selected).toBe(0);
    expect(sel.scrollOffset).toBe(0);
  });

  test("clampSelection clamps selected to itemCount-1", () => {
    const s = freshState();
    const sel = getSelection(s);
    sel.selected = 50;
    clampSelection(s, 0, 10);
    expect(sel.selected).toBe(9);
  });

  test("clampSelection handles empty list", () => {
    const s = freshState();
    // clampSelection on current tab (0) with itemCount 0
    clampSelection(s, 0, 0);
    expect(getSelection(s).selected).toBe(0);
  });
});

describe("moveSelection", () => {
  test("moves forward", () => {
    const s = freshState();
    // moveSelection on current tab (0)
    moveSelection(s, 0, 1, 10);
    expect(getSelection(s).selected).toBe(1);
  });

  test("moves backward", () => {
    const s = freshState();
    const sel = getSelection(s);
    sel.selected = 5;
    moveSelection(s, 0, -1, 10);
    expect(getSelection(s).selected).toBe(4);
  });

  test("does not go below 0", () => {
    const s = freshState();
    moveSelection(s, 0, -1, 10);
    expect(getSelection(s).selected).toBe(0);
  });

  test("does not exceed itemCount-1", () => {
    const s = freshState();
    moveSelection(s, 0, 99, 5);
    expect(getSelection(s).selected).toBe(4);
  });

  test("handles empty list gracefully", () => {
    const s = freshState();
    moveSelection(s, 0, 1, 0);
    expect(getSelection(s).selected).toBe(0);
  });
});

describe("switchTab", () => {
  test("changes tab and resets details", () => {
    const s = freshState();
    s.details = true;
    switchTab(s, 2, [0, 5, 10, 0, 0, 0, 0]);
    expect(s.tab).toBe(2);
    expect(s.details).toBe(false);
  });

  test("clamps selection for new tab", () => {
    const s = freshState();
    // switchTab clamps to itemCount-1 for the new tab
    // Tab 1 has itemCount 5, so selected stays at 0
    switchTab(s, 1, [0, 5, 0, 0, 0, 0, 0]);
    expect(getSelection(s).selected).toBe(0);
  });
});

describe("transitionFilter", () => {
  test("enters filter mode with current filter as initial value", () => {
    const s = freshState();
    s.filter = "test";
    const mode = transitionFilter(s);
    expect(mode.type).toBe("filter");
    if (mode.type === "filter") expect(mode.value).toBe("test");
  });

  test("no-op if not in normal mode", () => {
    const s = freshState();
    s.mode = { type: "confirm", decision: "approve" };
    const mode = transitionFilter(s);
    expect(mode.type).toBe("confirm");
  });
});

describe("applyFilter", () => {
  test("sets filter and resets selection", () => {
    const s = freshState();
    getSelection(s).selected = 5;
    applyFilter(s, "hello");
    expect(s.filter).toBe("hello");
    expect(s.mode.type).toBe("normal");
    expect(getSelection(s).selected).toBe(0);
  });
});

describe("transitionReject / transitionConfirm", () => {
  test("transitionReject enters reject mode", () => {
    const s = freshState();
    transitionReject(s);
    expect(s.mode.type).toBe("reject");
    if (s.mode.type === "reject") expect(s.mode.value).toBe("");
  });

  test("transitionConfirm enters confirm mode", () => {
    const s = freshState();
    transitionConfirm(s, "approve", "looks good");
    expect(s.mode.type).toBe("confirm");
    if (s.mode.type === "confirm") {
      expect(s.mode.decision).toBe("approve");
      expect(s.mode.note).toBe("looks good");
    }
  });
});

describe("cancelInput", () => {
  test("resets mode to normal", () => {
    const s = freshState();
    s.mode = { type: "confirm", decision: "reject" };
    cancelInput(s);
    expect(s.mode.type).toBe("normal");
  });
});

describe("filterApprovals", () => {
  const items = [
    { id: "a1", title: "Deploy to prod", requestedBy: "alice", assignedTo: "bob", risk: "high" },
    { id: "a2", title: "Update deps", requestedBy: "bob", assignedTo: "alice", risk: "low" },
    { id: "a3", title: "Rollback", requestedBy: "carol", assignedTo: "alice", risk: "medium" }
  ];

  test("empty query returns all", () => {
    expect(filterApprovals(items, "")).toHaveLength(3);
  });

  test("filters by title", () => {
    expect(filterApprovals(items, "deploy")).toHaveLength(1);
  });

  test("filters by id", () => {
    expect(filterApprovals(items, "a2")).toHaveLength(1);
  });

  test("filters by requester", () => {
    expect(filterApprovals(items, "carol")).toHaveLength(1);
  });

  test("filters by risk", () => {
    expect(filterApprovals(items, "high")).toHaveLength(1);
  });

  test("returns empty for no match", () => {
    expect(filterApprovals(items, "nonexistent")).toHaveLength(0);
  });

  test("case insensitive", () => {
    expect(filterApprovals(items, "DEPLOY")).toHaveLength(1);
  });
});
