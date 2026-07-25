import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Box,
  Text,
  render,
  useApp,
  useInput,
  useStdout
} from "ink";
import type { RuntimeClient } from "../runtime/client.js";
import type { ApprovalRequest, ControlCenterSnapshot } from "./types.js";
import { clean, riskTone, shortAge, truncate } from "./format.js";
import {
  applyFilter,
  cancelInput,
  createInitialState,
  filterApprovals,
  getSelection,
  moveSelection,
  switchTab,
  TABS,
  transitionConfirm,
  transitionFilter,
  transitionReject,
  type ConnectionStatus,
  type TabName
} from "./ink-state.js";
import { connectLiveUpdates, type LiveConnection } from "./live.js";

const VISIBLE_ROWS = 12;

interface ControlAppProps {
  client: RuntimeClient;
  initial: ControlCenterSnapshot;
  actor: string;
  intervalMs: number;
}

export async function renderControlInk(options: ControlAppProps): Promise<void> {
  const instance = render(<ControlApp {...options} />);
  await instance.waitUntilExit();
}

export function ControlApp({
  client,
  initial,
  actor,
  intervalMs
}: ControlAppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 100;
  const titleWidth = Math.max(42, terminalWidth - 50);

  const [snapshot, setSnapshot] = useState(initial);
  const [state, setState] = useState(() => createInitialState(TABS.length));
  const [message, setMessage] = useState("Runtime connected");
  const [statusKind, setStatusKind] = useState<"info" | "error">("info");
  const [busy, setBusy] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await client.getControlSnapshot());
      setMessage("Updated");
      setStatusKind("info");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
    }
  }, [client]);

  // Safety poll: refresh every 15×interval regardless of WS state
  const safetyPoll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    safetyPoll.current = setInterval(() => void refresh(), intervalMs * 15);
    return () => clearInterval(safetyPoll.current);
  }, [intervalMs, refresh]);

  // Live WebSocket updates
  useEffect(() => {
    const live: LiveConnection = connectLiveUpdates({
      url: client.webSocketUrl(0),
      onEvent: () => void refresh(),
      onStatusChange: (status: ConnectionStatus) => {
        setState((prev) => ({ ...prev, connection: status }));
      }
    });
    return () => live.dispose();
  }, [client, refresh]);

  const filteredApprovals = useMemo(
    () => filterApprovals(snapshot.approvals.items, state.filter),
    [snapshot.approvals.items, state.filter]
  );

  const selectedApproval = filteredApprovals[getSelection(state).selected];

  const decide = useCallback(async (
    approval: ApprovalRequest,
    decision: "approve" | "reject",
    note?: string
  ) => {
    setBusy(true);
    try {
      const updated = await client.decideApproval(approval.id, {
        decision,
        decidedBy: actor,
        expectedVersion: approval.version,
        channel: "tui",
        note
      });
      setMessage(
        updated.status === "pending"
          ? `Vote recorded (${updated.approvalCount}/${updated.requiredApprovals})`
          : `Approval ${updated.status}`
      );
      setStatusKind("info");
      cancelInput(stateRef.current);
      setState({ ...stateRef.current });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
      cancelInput(stateRef.current);
      setState({ ...stateRef.current });
    } finally {
      setBusy(false);
    }
  }, [actor, client, refresh]);

  const doTaskAction = useCallback(async (id: string, action: "submit" | "close") => {
    setBusy(true);
    try {
      if (action === "submit") {
        await client.submitControlTask(id, { actor });
        setMessage("Task submitted for review.");
      } else {
        await client.closeControlTask(id, { actor });
        setMessage("Task closed.");
      }
      setStatusKind("info");
      cancelInput(stateRef.current);
      setState({ ...stateRef.current });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
      cancelInput(stateRef.current);
      setState({ ...stateRef.current });
    } finally {
      setBusy(false);
    }
  }, [actor, client, refresh]);

  const doScheduleAction = useCallback(async (
    id: string,
    action: "run" | "toggle" | "delete",
    currentStatus?: string
  ) => {
    setBusy(true);
    try {
      if (action === "run") {
        await client.runSchedule(id);
        setMessage("Schedule run completed.");
      } else if (action === "toggle") {
        const nextStatus = currentStatus === "active" ? "paused" : "active";
        await client.updateSchedule(id, { status: nextStatus });
        setMessage(`Schedule ${nextStatus}.`);
      } else {
        await client.removeSchedule(id);
        setMessage("Schedule deleted.");
      }
      setStatusKind("info");
      cancelInput(stateRef.current);
      setState({ ...stateRef.current });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
      cancelInput(stateRef.current);
      setState({ ...stateRef.current });
    } finally {
      setBusy(false);
    }
  }, [client, refresh]);

  const doMemoryMaintenance = useCallback(async () => {
    setBusy(true);
    try {
      const result = await client.runMemoryMaintenance();
      setMessage(`Maintenance done — pruned ${result.project.pruned.length}, promoted ${result.project.promoted.length}.`);
      setStatusKind("info");
      cancelInput(stateRef.current);
      setState({ ...stateRef.current });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setStatusKind("error");
      cancelInput(stateRef.current);
      setState({ ...stateRef.current });
    } finally {
      setBusy(false);
    }
  }, [client, refresh]);

  const currentTabName = TABS[state.tab] as TabName;

  const getItemCount = useCallback((tabIndex: number): number => {
    const name = TABS[tabIndex];
    switch (name) {
      case "Approvals": return filteredApprovals.length;
      case "Tasks": return snapshot.tasks.recent.length;
      case "Agents": return snapshot.agents.items.length;
      case "Scheduler": return snapshot.schedules.length;
      default: return 0;
    }
  }, [filteredApprovals.length, snapshot]);

  const clampCurrent = useCallback(() => {
    const count = getItemCount(stateRef.current.tab);
    const sel = getSelection(stateRef.current);
    if (count <= 0) {
      sel.selected = 0;
      sel.scrollOffset = 0;
      return;
    }
    sel.selected = Math.min(sel.selected, count - 1);
    if (sel.selected < sel.scrollOffset) sel.scrollOffset = sel.selected;
    if (sel.selected >= sel.scrollOffset + VISIBLE_ROWS) {
      sel.scrollOffset = sel.selected - VISIBLE_ROWS + 1;
    }
  }, [getItemCount]);

  useInput((input, key) => {
    if (busyRef.current) return;

    const mode = stateRef.current.mode;

    if (mode.type === "filter" || mode.type === "reject") {
      if (key.escape) {
        cancelInput(stateRef.current);
        setState({ ...stateRef.current });
        return;
      }
      if (key.return) {
        if (mode.type === "filter") {
          applyFilter(stateRef.current, mode.value);
          setState({ ...stateRef.current });
        } else {
          stateRef.current.mode = { type: "confirm", decision: "reject", note: mode.value.trim() || "Rejected from Oracle Control." };
          setState({ ...stateRef.current });
        }
        return;
      }
      if (key.backspace || key.delete) {
        stateRef.current.mode = { ...mode, value: mode.value.slice(0, -1) };
        setState({ ...stateRef.current });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        stateRef.current.mode = { ...mode, value: mode.value + input };
        setState({ ...stateRef.current });
      }
      return;
    }

    if (mode.type === "confirm") {
      if ((input === "y" || key.return) && selectedApproval && mode.decision) {
        void decide(selectedApproval, mode.decision, mode.note);
      } else if (input === "n" || key.escape) {
        cancelInput(stateRef.current);
        setState({ ...stateRef.current });
      }
      return;
    }

    // Normal mode navigation
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }

    if (key.leftArrow) {
      const next = (stateRef.current.tab + TABS.length - 1) % TABS.length;
      switchTab(stateRef.current, next, TABS.map((_t, i) => getItemCount(i)));
      setState({ ...stateRef.current });
      return;
    }
    if (key.rightArrow || key.tab) {
      const next = (stateRef.current.tab + 1) % TABS.length;
      switchTab(stateRef.current, next, TABS.map((_t, i) => getItemCount(i)));
      setState({ ...stateRef.current });
      return;
    }

    if (currentTabName === "Approvals" && (input === "a" || input === "x") && selectedApproval) {
      if (input === "a") {
        transitionConfirm(stateRef.current, "approve");
      } else {
        transitionReject(stateRef.current);
      }
      setState({ ...stateRef.current });
      return;
    }

    if (currentTabName === "Approvals" && input === "/") {
      transitionFilter(stateRef.current);
      setState({ ...stateRef.current });
      return;
    }

    if (input === "r") {
      void refresh();
      return;
    }

    const itemCount = getItemCount(stateRef.current.tab);
    if ((input === "j" || key.downArrow) && itemCount > 0) {
      moveSelection(stateRef.current, stateRef.current.tab, 1, itemCount);
      setState({ ...stateRef.current });
      return;
    }
    if ((input === "k" || key.upArrow) && itemCount > 0) {
      moveSelection(stateRef.current, stateRef.current.tab, -1, itemCount);
      setState({ ...stateRef.current });
      return;
    }

    if (key.return && currentTabName === "Approvals") {
      setState((prev) => ({ ...prev, details: !prev.details }));
      return;
    }

    // Per-tab actions
    if (currentTabName === "Tasks" && input === "s") {
      clampCurrent();
      const task = snapshot.tasks.recent[getSelection(stateRef.current).selected];
      if (task && (task.status === "pending" || task.status === "in_progress" || task.status === "blocked")) {
        void doTaskAction(task.id, "submit");
      }
      return;
    }
    if (currentTabName === "Tasks" && input === "c") {
      clampCurrent();
      const task = snapshot.tasks.recent[getSelection(stateRef.current).selected];
      if (task && task.status === "review") {
        void doTaskAction(task.id, "close");
      }
      return;
    }
    if (currentTabName === "Scheduler" && input === "r") {
      clampCurrent();
      const job = snapshot.schedules[getSelection(stateRef.current).selected];
      if (job) void doScheduleAction(job.id, "run");
      return;
    }
    if (currentTabName === "Scheduler" && input === "p") {
      clampCurrent();
      const job = snapshot.schedules[getSelection(stateRef.current).selected];
      if (job) void doScheduleAction(job.id, "toggle", job.status);
      return;
    }
    if (currentTabName === "Scheduler" && input === "d") {
      clampCurrent();
      const job = snapshot.schedules[getSelection(stateRef.current).selected];
      if (job) void doScheduleAction(job.id, "delete");
      return;
    }
    if (currentTabName === "Memory" && input === "m") {
      void doMemoryMaintenance();
      return;
    }
  });

  const keyHints = (tab: TabName): string => {
    switch (tab) {
      case "Approvals": return "j/k select · Enter details · / filter · a approve · x reject";
      case "Tasks":     return "j/k select · s submit · c close";
      case "Scheduler": return "j/k select · r run now · p pause/resume · d delete";
      case "Memory":    return "m run maintenance";
      default:          return "";
    }
  };

  const connectionDot = state.connection === "live" ? "●" : "○";
  const connectionColor = state.connection === "live" ? "green" : "yellow";

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="blue" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">ORACLE CONTROL</Text>
        <Text>
          <Text color={connectionColor}>{connectionDot} {state.connection.toUpperCase()}</Text>
          {' '}
          <Text color={snapshot.runtime.schedulerRunning ? "green" : "red"}>
            Runtime {snapshot.version} · pid {snapshot.runtime.pid}
          </Text>
        </Text>
      </Box>
      <Box paddingX={1} gap={2}>
        {TABS.map((name, index) => (
          <Text key={name} bold={index === state.tab} inverse={index === state.tab} color={index === state.tab ? "cyan" : "gray"}>
            {name}
          </Text>
        ))}
      </Box>
      <Box borderStyle="single" borderColor="blue" paddingX={1} minHeight={15} flexDirection="column">
        <TabContent
          tab={currentTabName}
          snapshot={snapshot}
          approvals={filteredApprovals}
          selected={getSelection(state).selected}
          scrollOffset={getSelection(state).scrollOffset}
          details={state.details}
          titleWidth={titleWidth}
        />
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Text color="gray">←/→ tabs · {keyHints(currentTabName)} · r refresh · q quit</Text>
        <Text color={statusKind === "error" ? "red" : "cyan"}>{busy ? "Working…" : message}</Text>
      </Box>
      {state.filter && <Text color="yellow"> Filter: {state.filter}</Text>}
      {state.mode.type === "filter" && <Prompt label="Filter" value={state.mode.value} />}
      {state.mode.type === "reject" && <Prompt label="Reject reason" value={state.mode.value} />}
      {state.mode.type === "confirm" && (
        <Text color="yellow">
          {state.mode.decision === "approve" ? "Approve" : "Reject"} {selectedApproval?.id ?? "?"}? y/Enter confirm · n/Esc cancel
        </Text>
      )}
    </Box>
  );
}

function TabContent(props: {
  tab: TabName;
  snapshot: ControlCenterSnapshot;
  approvals: ApprovalRequest[];
  selected: number;
  scrollOffset: number;
  details: boolean;
  titleWidth: number;
}): React.ReactElement {
  const { tab, snapshot, scrollOffset, titleWidth } = props;

  switch (tab) {
    case "Overview":
      return (
        <>
          <Text bold color="cyan">Human Control Plane</Text>
          <Text>Approvals: <Text color="yellow">{snapshot.approvals.pending}</Text> · High risk: <Text color="red">{snapshot.approvals.byRisk.high}</Text></Text>
          <Text>Tasks: <Text color="cyan">{snapshot.tasks.active}/{snapshot.tasks.total}</Text> active · Agents: <Text color="green">{snapshot.agents.active}/{snapshot.agents.total}</Text> active</Text>
          <Text>Memory: {snapshot.memory.project.total} project · Scheduler: {snapshot.schedules.length} jobs</Text>
          <Text>
            Audit: {snapshot.audit.integrity.valid
              ? <Text color="green">{snapshot.audit.integrity.verifiedEntries} verified</Text>
              : <Text color="red">broken at {snapshot.audit.integrity.brokenAt}</Text>}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Pending approvals</Text>
            <ApprovalList approvals={props.approvals} selected={props.selected} details={props.details} limit={6} titleWidth={titleWidth} />
          </Box>
        </>
      );

    case "Approvals":
      return <ApprovalList approvals={props.approvals} selected={props.selected} details={props.details} titleWidth={titleWidth} />;

    case "Tasks": {
      const visible = snapshot.tasks.recent.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);
      return (
        <>
          <Text bold>Task workflow</Text>
          <Text>
            pending {snapshot.tasks.byStatus.pending} · active {snapshot.tasks.byStatus.in_progress} · review {snapshot.tasks.byStatus.review} · blocked {snapshot.tasks.byStatus.blocked} · done {snapshot.tasks.byStatus.done}
          </Text>
          {visible.map((task) => (
            <Text key={task.id} color={task.status === "blocked" ? "red" : task.status === "done" ? "green" : undefined}>
              {task.status.padEnd(11)} {truncate(task.title, titleWidth)} · {clean(task.assignee)}
            </Text>
          ))}
        </>
      );
    }

    case "Memory":
      return (
        <>
          <Text bold>Persistent memory</Text>
          <Text>Project {snapshot.memory.project.total} · Global {snapshot.memory.global.total}</Text>
          {snapshot.memory.project.recent.slice(0, 10).map((entry) => (
            <Text key={entry.id}><Text color="cyan">{entry.type.padEnd(10)}</Text> {truncate(entry.content, titleWidth)}</Text>
          ))}
          {snapshot.memory.global.recent.length > 0 && (
            <>
              <Box marginTop={1}><Text bold>Global entries</Text></Box>
              {snapshot.memory.global.recent.slice(0, 5).map((entry) => (
                <Text key={entry.id}><Text color="cyan">{entry.type.padEnd(10)}</Text> {truncate(entry.content, titleWidth)}</Text>
              ))}
            </>
          )}
        </>
      );

    case "Audit":
      return (
        <>
          <Text bold>Audit chain</Text>
          <Text color={snapshot.audit.integrity.valid ? "green" : "red"}>
            {snapshot.audit.integrity.valid ? "VALID" : "INVALID"} · {snapshot.audit.integrity.verifiedEntries} verified · {snapshot.audit.integrity.legacyEntries} legacy
          </Text>
          {snapshot.audit.recent.slice(scrollOffset, scrollOffset + VISIBLE_ROWS).map((entry, index) => (
            <Text key={`${entry.timestamp}-${index}`} color={entry.action === "policy_denied" ? "red" : undefined}>
              {String(entry.sequence ?? "—").padStart(4)} {entry.action.padEnd(14)} {truncate(entry.target, titleWidth)}
            </Text>
          ))}
        </>
      );

    case "Agents":
      return (
        <>
          <Text bold>Agent presence</Text>
          {snapshot.agents.items.length
            ? snapshot.agents.items.slice(scrollOffset, scrollOffset + VISIBLE_ROWS).map((agent) => (
                <Text key={agent.name} color={agent.active ? "green" : "gray"}>
                  {agent.active ? "●" : "○"} {clean(agent.name).padEnd(18)} {clean(agent.role ?? "—")} · {shortAge(agent.lastSeen)}
                </Text>
              ))
            : <Text color="gray">No registered agents</Text>}
        </>
      );

    case "Scheduler":
      return (
        <>
          <Text bold>Scheduler</Text>
          {snapshot.schedules.length
            ? snapshot.schedules.slice(scrollOffset, scrollOffset + VISIBLE_ROWS).map((schedule) => (
                <Text key={schedule.id} color={schedule.status === "active" ? "green" : "gray"}>
                  {schedule.status.padEnd(7)} {schedule.cron.padEnd(16)} {truncate(clean(schedule.name), titleWidth)}
                </Text>
              ))
            : <Text color="gray">No scheduled jobs</Text>}
        </>
      );
  }
}

function ApprovalList(props: {
  approvals: ApprovalRequest[];
  selected: number;
  details: boolean;
  limit?: number;
  titleWidth: number;
}): React.ReactElement {
  const items = props.limit ? props.approvals.slice(0, props.limit) : props.approvals;
  if (!items.length) return <Text color="green">✓ No pending approvals</Text>;
  return (
    <>
      {items.slice(0, VISIBLE_ROWS).map((approval, index) => (
        <Box key={approval.id} flexDirection="column">
          <Text inverse={index === props.selected}>
            <Text color={riskTone(approval.risk) === "danger" ? "red" : riskTone(approval.risk) === "warn" ? "yellow" : "green"}>
              {approval.risk.toUpperCase().padEnd(6)}
            </Text>
            {" "}{truncate(approval.title, props.titleWidth).padEnd(props.titleWidth)} {approval.approvalCount}/{approval.requiredApprovals}
          </Text>
          {props.details && index === props.selected && (
            <Box marginLeft={2} flexDirection="column">
              <Text color="gray">{approval.id} · v{approval.version}</Text>
              <Text>Reviewers: {approval.authorizedReviewers.join(", ")}</Text>
              {approval.description && <Text>{truncate(approval.description, props.titleWidth)}</Text>}
              {approval.expiresAt && <Text color="yellow">Expires {new Date(approval.expiresAt).toLocaleString()}</Text>}
              {approval.payloadHash && <Text color="gray">Payload {approval.payloadHash}</Text>}
            </Box>
          )}
        </Box>
      ))}
    </>
  );
}

function Prompt({ label, value }: { label: string; value: string }): React.ReactElement {
  return <Text color="yellow"> {label}: {value}<Text inverse> </Text></Text>;
}
