/** Shared formatting helpers for CLI control output. */

export type RiskTone = "danger" | "warn" | "ok";

/** Replace C0/C1 control characters so untrusted fields can't inject ANSI escapes. */
export function clean(value: unknown): string {
  const text = String(value ?? "");
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 32 || (code >= 127 && code <= 159) ? " " : char;
  }
  return out;
}

export function truncate(value: unknown, width: number): string {
  const text = clean(value);
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

export function shortAge(timestamp: string | undefined): string {
  if (!timestamp) return "—";
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return "—";
  const elapsed = Math.max(0, Date.now() - time);
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function riskTone(risk: string): RiskTone {
  if (risk === "high") return "danger";
  if (risk === "medium") return "warn";
  return "ok";
}
