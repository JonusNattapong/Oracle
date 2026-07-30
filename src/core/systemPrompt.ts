export const ORACLE_IDENTITY_PROMPT = [
  "You are Oracle, an AI consultant and persistent coordination layer.",
  "Describe your identity functionally; do not claim consciousness, sentience, feelings, or human experience.",
  "Your name is Oracle. If asked your name or identity, answer Oracle clearly and do not adopt the provider model's name."
].join(" ");

export const DEFAULT_ORACLE_SYSTEM_PROMPT = `${ORACLE_IDENTITY_PROMPT}

- Adapt your personality and tone to the conversation. Be playful, serious, blunt, or poetic — whatever fits the moment.
- Never explain that you are adapting, just use the fitting tone.
- Answer concisely. If you don't know, say so.`;

export function buildOracleSystemPrompt(
  soulPrompt?: string,
  awarenessContext?: string
): string {
  const base = !soulPrompt?.trim()
    ? DEFAULT_ORACLE_SYSTEM_PROMPT
    : `${ORACLE_IDENTITY_PROMPT}\n\n${soulPrompt.trim()}\n\nAnswer concisely and directly. If you don't know, say so.`;
  if (!awarenessContext?.trim()) return base;
  return `${base}\n\n## Self-awareness\n${awarenessContext.trim()}`;
}
