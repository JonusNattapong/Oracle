/** Pure state-machine logic for the Ink TUI. No Ink / React dependency — testable without rendering. */

export type Decision = "approve" | "reject";
export type ConnectionStatus = "live" | "polling" | "offline";

export interface NormalMode {
  type: "normal";
}
export interface FilterMode {
  type: "filter";
  value: string;
}
export interface RejectMode {
  type: "reject";
  value: string;
}
export interface ConfirmMode {
  type: "confirm";
  decision: Decision;
  note?: string;
}

export type InputMode = NormalMode | FilterMode | RejectMode | ConfirmMode;

export interface TabSelection {
  selected: number;
  scrollOffset: number;
}

export interface TuiState {
  tab: number;
  tabSelection: Record<number, TabSelection>;
  mode: InputMode;
  filter: string;
  details: boolean;
  connection: ConnectionStatus;
}

const INITIAL_SELECTION: TabSelection = { selected: 0, scrollOffset: 0 };
const VISIBLE_ROWS = 12;

export function createInitialState(tabCount: number): TuiState {
  return {
    tab: 0,
    tabSelection: {},
    mode: { type: "normal" },
    filter: "",
    details: false,
    connection: "polling"
  };
}

function ensureSelection(state: TuiState, tabIndex: number): TabSelection {
  if (!state.tabSelection[tabIndex]) {
    state.tabSelection[tabIndex] = { ...INITIAL_SELECTION };
  }
  return state.tabSelection[tabIndex];
}

export function getSelection(state: TuiState): TabSelection {
  return ensureSelection(state, state.tab);
}

export function clampSelection(
  state: TuiState,
  tabIndex: number,
  itemCount: number
): TabSelection {
  const sel = ensureSelection(state, tabIndex);
  if (itemCount <= 0) {
    sel.selected = 0;
    sel.scrollOffset = 0;
    return sel;
  }
  sel.selected = Math.min(sel.selected, itemCount - 1);
  if (sel.selected < sel.scrollOffset) {
    sel.scrollOffset = sel.selected;
  }
  if (sel.selected >= sel.scrollOffset + VISIBLE_ROWS) {
    sel.scrollOffset = sel.selected - VISIBLE_ROWS + 1;
  }
  return sel;
}

export function moveSelection(
  state: TuiState,
  tabIndex: number,
  delta: number,
  itemCount: number
): TabSelection {
  const sel = ensureSelection(state, tabIndex);
  if (itemCount <= 0) return sel;
  sel.selected = Math.max(0, Math.min(sel.selected + delta, itemCount - 1));
  if (sel.selected < sel.scrollOffset) {
    sel.scrollOffset = sel.selected;
  }
  if (sel.selected >= sel.scrollOffset + VISIBLE_ROWS) {
    sel.scrollOffset = sel.selected - VISIBLE_ROWS + 1;
  }
  return sel;
}

export function switchTab(state: TuiState, tabIndex: number, itemCounts: number[]): void {
  state.tab = tabIndex;
  state.details = false;
  if (itemCounts[tabIndex] !== undefined) {
    clampSelection(state, tabIndex, itemCounts[tabIndex]);
  }
}

export function transitionFilter(state: TuiState): InputMode {
  if (state.mode.type !== "normal") return state.mode;
  state.mode = { type: "filter", value: state.filter };
  return state.mode;
}

export function applyFilter(state: TuiState, value: string): void {
  state.filter = value;
  state.mode = { type: "normal" };
  const sel = getSelection(state);
  sel.selected = 0;
  sel.scrollOffset = 0;
}

export function transitionReject(state: TuiState): InputMode {
  if (state.mode.type !== "normal") return state.mode;
  state.mode = { type: "reject", value: "" };
  return state.mode;
}

export function transitionConfirm(state: TuiState, decision: Decision, note?: string): InputMode {
  state.mode = { type: "confirm", decision, note };
  return state.mode;
}

export function cancelInput(state: TuiState): void {
  state.mode = { type: "normal" };
}

export function filterApprovals<T extends { id: string; title: string; requestedBy: string; assignedTo: string; risk: string }>(
  items: T[],
  query: string
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return items;
  return items.filter((item) =>
    [item.id, item.title, item.requestedBy, item.assignedTo, item.risk]
      .some((value) => value.toLowerCase().includes(trimmed))
  );
}

export const TABS = [
  "Overview",
  "Approvals",
  "Tasks",
  "Memory",
  "Audit",
  "Agents",
  "Scheduler"
] as const;

export type TabName = (typeof TABS)[number];
