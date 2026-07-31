import crypto from "node:crypto";
import { OracleError } from "../errors.js";
import type { ConsultResult } from "../types.js";
import {
  PANEL_MANIFEST_VERSION,
  type PanelManifest,
  type PanelMember,
  type PanelMemberResult,
  type PanelStatus
} from "./types.js";

export const DEFAULT_PANEL_CONCURRENCY = 3;

function invalid(message: string, suggestion: string): OracleError {
  return new OracleError("ORACLE_INVALID_REQUEST", message, suggestion);
}

/**
 * Parses one `--member` spec. Accepted forms:
 *
 *   backend                    → id "backend", backend's default model
 *   backend:model              → id "backend:model"
 *   label=backend              → id "label"
 *   label=backend:model        → id "label"
 *
 * `parseBackend` is injected so this stays a pure string function and the
 * panel does not depend on the provider registry to be testable.
 */
export function parsePanelMember(
  spec: string,
  parseBackend: (value: string) => string
): PanelMember {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw invalid(
      "A panel member spec must not be empty.",
      "Pass --member <backend>[:<model>] or --member <label>=<backend>[:<model>]."
    );
  }

  const equals = trimmed.indexOf("=");
  const label = equals >= 0 ? trimmed.slice(0, equals).trim() : undefined;
  const target = equals >= 0 ? trimmed.slice(equals + 1).trim() : trimmed;
  if (equals >= 0 && !label) {
    throw invalid(
      `Panel member '${spec}' has an empty label.`,
      "Write it as <label>=<backend>[:<model>]."
    );
  }
  if (!target) {
    throw invalid(
      `Panel member '${spec}' has no backend.`,
      "Write it as <label>=<backend>[:<model>]."
    );
  }

  const colon = target.indexOf(":");
  const backendName = colon >= 0 ? target.slice(0, colon).trim() : target;
  const model = colon >= 0 ? target.slice(colon + 1).trim() : undefined;
  if (colon >= 0 && !model) {
    throw invalid(
      `Panel member '${spec}' has an empty model.`,
      "Write it as <backend>:<model>, or drop the colon to use the backend default."
    );
  }

  const backend = parseBackend(backendName);
  return { id: label ?? target, backend, ...(model ? { model } : {}) };
}

export function parsePanelMembers(
  specs: readonly string[],
  parseBackend: (value: string) => string
): PanelMember[] {
  if (specs.length === 0) {
    throw invalid(
      "A panel needs at least one member.",
      "Pass --member <backend>[:<model>] at least once."
    );
  }
  const members = specs.map((spec) => parsePanelMember(spec, parseBackend));
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.id)) {
      throw invalid(
        `Duplicate panel member '${member.id}'.`,
        "Give each seat a distinct label: --member reviewer=anthropic --member second=anthropic."
      );
    }
    seen.add(member.id);
  }
  return members;
}

/** Runs one member's consult. Rejecting is fine — the panel records it. */
export type PanelMemberRunner = (member: PanelMember) => Promise<ConsultResult>;

export interface RunPanelOptions {
  prompt: string;
  cwd: string;
  members: readonly PanelMember[];
  concurrency?: number;
  now?: () => Date;
  /** Monotonic-ish clock for durations; injected so tests can be deterministic. */
  elapsed?: () => number;
}

function panelStatus(succeeded: number, requested: number): PanelStatus {
  if (succeeded === requested) return "complete";
  if (succeeded === 0) return "failed";
  return "partial";
}

function createPanelId(now: Date): string {
  const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `panel-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Asks every member the same question and returns a manifest.
 *
 * A member that fails — rejected promise, thrown error, or a consult record
 * with status "error" — never stops the others and never fails the panel. That
 * is the whole point of the manifest: it reports exactly who answered and who
 * did not, so a partial result stays usable.
 *
 * Results are returned in member order regardless of completion order, so two
 * runs of the same panel are diffable.
 */
export async function runPanel(options: RunPanelOptions, run: PanelMemberRunner): Promise<PanelManifest> {
  const now = options.now ?? (() => new Date());
  const elapsed = options.elapsed ?? (() => Date.now());
  const members = [...options.members];
  if (members.length === 0) {
    throw invalid(
      "A panel needs at least one member.",
      "Pass --member <backend>[:<model>] at least once."
    );
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_PANEL_CONCURRENCY, members.length));

  const startedAt = now();
  const panelStart = elapsed();
  const results = new Array<PanelMemberResult>(members.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= members.length) return;
      const member = members[index]!;
      const memberStart = elapsed();
      try {
        const record = await run(member);
        results[index] = {
          id: member.id,
          backend: member.backend,
          ...(member.model ? { model: member.model } : {}),
          status: record.status,
          sessionId: record.sessionId,
          ...(record.status === "completed"
            ? { output: record.output }
            : { error: record.error ?? "The backend reported an error with no message." }),
          usage: record.usage,
          durationMs: elapsed() - memberStart
        };
      } catch (error) {
        results[index] = {
          id: member.id,
          backend: member.backend,
          ...(member.model ? { model: member.model } : {}),
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          durationMs: elapsed() - memberStart
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const members_ = results as PanelMemberResult[];
  const succeeded = members_.filter((result) => result.status === "completed").length;
  const completedAt = now();
  return {
    version: PANEL_MANIFEST_VERSION,
    id: createPanelId(startedAt),
    createdAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: elapsed() - panelStart,
    prompt: options.prompt,
    cwd: options.cwd,
    status: panelStatus(succeeded, members_.length),
    requested: members_.length,
    succeeded,
    failed: members_.length - succeeded,
    members: members_
  };
}

/** Human-readable panel report. */
export function formatPanelManifest(manifest: PanelManifest): string {
  const lines: string[] = [];
  const headline =
    manifest.status === "complete"
      ? `All ${manifest.requested} members answered.`
      : manifest.status === "partial"
        ? `${manifest.succeeded} of ${manifest.requested} members answered; ${manifest.failed} failed.`
        : `No member answered (${manifest.failed} failed).`;
  lines.push(`Panel ${manifest.id} — ${headline}`);
  lines.push("");

  for (const member of manifest.members) {
    if (member.status === "completed") {
      lines.push(`## ${member.id} (${describeTarget(member)})`);
      lines.push("");
      lines.push(member.output ?? "");
      lines.push("");
    }
  }

  const failures = manifest.members.filter((member) => member.status === "error");
  if (failures.length > 0) {
    lines.push("## Did not answer");
    lines.push("");
    for (const member of failures) {
      lines.push(`- ${member.id} (${describeTarget(member)}): ${member.error}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function describeTarget(member: PanelMemberResult): string {
  return member.model ? `${member.backend}:${member.model}` : member.backend;
}
