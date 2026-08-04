export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /(?:you(?:'ve| have)|we(?:'ve| have))\s+(?:reached|hit)\s+(?:your|the)\s+(?:limit|usage limit|message limit)/i,
  /(?:usage|message|request)\s+(?:cap|limit)\s+(?:has been|was)\s+(?:reached|hit)/i,
  /(?:you(?:'ve| have)|we(?:'ve| have))\s+(?:reached|hit)\s+(?:your|the)\s+(?:usage|message|request)\s+cap/i,
  /upgrade\s+to\s+continue/i,
  /(?:try again|come back|retry)\s+(?:in|after|at)\s+[^.\n]+/i,
  /(?:limit|quota)\s+(?:for|on)\s+(?:GPT[- ]?[\w.]+|o[\w.-]+)/i,
  /free\s+plan\s+limit/i,
];

const RETRY_AFTER_PATTERNS: RegExp[] = [
  /(?:try again|retry|come back)\s+(?:in|after|at)\s+([^.!?\n]+)/i,
  /(?:reset|resets|available again)\s+(?:in|at|after)\s+([^.!?\n]+)/i,
];

export function detectRateLimit(text: string): { limited: boolean; retryAfter?: string } {
  if (!RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { limited: false };
  }
  const retryAfter = RETRY_AFTER_PATTERNS
    .map((pattern) => pattern.exec(text)?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  return retryAfter ? { limited: true, retryAfter } : { limited: true };
}
