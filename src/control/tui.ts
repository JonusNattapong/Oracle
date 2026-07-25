import type { ApprovalRequest, ControlCenterSnapshot } from "./types.js";
import { clean, riskTone, shortAge, truncate } from "./format.js";

const BLUE = "\x1b[38;5;39m";
const CYAN = "\x1b[38;5;45m";
const GREEN = "\x1b[38;5;48m";
const AMBER = "\x1b[38;5;214m";
const RED = "\x1b[38;5;203m";
const MUTED = "\x1b[38;5;245m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const INVERT = "\x1b[7m";

export function renderControlTui(
  snapshot: ControlCenterSnapshot,
  selectedApproval = 0,
  width = process.stdout.columns ?? 100
): string {
  const usable = Math.max(72, Math.min(width, 140));
  const line = "─".repeat(usable);
  const output: string[] = [
    `${BLUE}${BOLD} ORACLE CONTROL CENTER ${RESET}${MUTED}v${clean(snapshot.version)}${RESET}`,
    `${MUTED}${clean(snapshot.workspaceRoot)} · pid ${snapshot.runtime.pid} · ${snapshot.runtime.schedulerRunning ? `${GREEN}runtime live` : `${RED}runtime stopped`}${RESET}`,
    `${BLUE}${line}${RESET}`,
    metricRow(snapshot, usable),
    `${BLUE}${line}${RESET}`,
    `${BOLD} TASK WORKFLOW${RESET}`,
    taskFlow(snapshot, usable),
    "",
    `${BOLD} APPROVAL INBOX${RESET} ${MUTED}(j/k select · a approve · x reject · r refresh · q quit)${RESET}`,
    ...approvalRows(snapshot.approvals.items, selectedApproval, usable),
    "",
    `${BOLD} MEMORY${RESET}`,
    ...memoryRows(snapshot, usable),
    "",
    `${BOLD} AUDIT${RESET}`,
    ...auditRows(snapshot, usable),
    `${BLUE}${line}${RESET}`,
    `${MUTED}Updated ${new Date(snapshot.generatedAt).toLocaleString()} · Web dashboard: oracle control url${RESET}`
  ];
  return output.join("\n");
}

function metricRow(snapshot: ControlCenterSnapshot, width: number): string {
  const metrics = [
    `${AMBER}${snapshot.approvals.pending}${RESET} approvals`,
    `${CYAN}${snapshot.tasks.active}${RESET}/${snapshot.tasks.total} active tasks`,
    `${BLUE}${snapshot.memory.project.total}${RESET} project memories`,
    `${snapshot.audit.policyDenials ? RED : GREEN}${snapshot.audit.policyDenials}${RESET} policy denials`
  ];
  return ` ${metrics.join(pad(width > 100 ? 8 : 3))}`;
}

function taskFlow(snapshot: ControlCenterSnapshot, width: number): string {
  const labels: Array<[keyof typeof snapshot.tasks.byStatus, string, string]> = [
    ["pending", "pending", MUTED],
    ["in_progress", "active", BLUE],
    ["review", "review", AMBER],
    ["blocked", "blocked", RED],
    ["done", "done", GREEN],
    ["cancelled", "cancelled", MUTED]
  ];
  const max = Math.max(1, ...Object.values(snapshot.tasks.byStatus));
  const barWidth = Math.max(3, Math.min(12, Math.floor((width - 70) / 6)));
  return labels.map(([status, label, color]) => {
    const value = snapshot.tasks.byStatus[status];
    const fill = Math.round((value / max) * barWidth);
    return `${color}${label.padEnd(11)}${RESET} ${"█".repeat(fill)}${"░".repeat(barWidth - fill)} ${String(value).padStart(3)}`;
  }).join("  ");
}

function approvalRows(items: ApprovalRequest[], selected: number, width: number): string[] {
  if (!items.length) return [` ${GREEN}✓ No pending approvals${RESET}`];
  return items.slice(0, 8).map((item, index) => {
    const marker = index === selected ? `${INVERT}>${RESET}` : " ";
    const tone = riskTone(item.risk);
    const risk = tone === "danger" ? RED : tone === "warn" ? AMBER : GREEN;
    const titleWidth = Math.max(22, width - 58);
    return `${marker} ${risk}${item.risk.toUpperCase().padEnd(6)}${RESET} ${truncate(item.title, titleWidth).padEnd(titleWidth)} ${MUTED}${truncate(item.assignedTo, 16).padEnd(16)} ${shortAge(item.createdAt)}${RESET}`;
  });
}

function memoryRows(snapshot: ControlCenterSnapshot, width: number): string[] {
  const entries = Object.entries(snapshot.memory.project.byType).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return [` ${MUTED}No project memory yet${RESET}`];
  const max = Math.max(1, ...entries.map(([, count]) => count));
  const barWidth = Math.max(12, Math.min(38, width - 34));
  return entries.slice(0, 6).map(([type, count]) => {
    const fill = Math.max(1, Math.round((count / max) * barWidth));
    return ` ${type.padEnd(12)} ${BLUE}${"█".repeat(fill)}${RESET}${MUTED}${"░".repeat(barWidth - fill)}${RESET} ${String(count).padStart(4)}`;
  });
}

function auditRows(snapshot: ControlCenterSnapshot, width: number): string[] {
  if (!snapshot.audit.recent.length) return [` ${MUTED}No audit events yet${RESET}`];
  return snapshot.audit.recent.slice(0, 6).map((record) => {
    const color = record.action === "policy_denied" ? RED : CYAN;
    const targetWidth = Math.max(20, width - 48);
    return ` ${color}●${RESET} ${record.action.padEnd(14)} ${truncate(record.target, targetWidth).padEnd(targetWidth)} ${MUTED}${shortAge(record.timestamp)}${RESET}`;
  });
}

function pad(count: number): string {
  return " ".repeat(count);
}
