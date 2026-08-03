/**
 * Authoritative reads of the signed-in account's Saved Memory.
 *
 * Asking ChatGPT to describe its own Saved Memory is not trustworthy in either
 * direction, and both failure modes were observed live:
 * - it answered with an empty list while four memories were stored, and
 * - it emitted the "saved" confirmation for an entry it never created.
 *
 * The account's own endpoint is the only source that can settle either question,
 * so it is used to verify what the conversational channel claims. It is an
 * internal API and may change without notice, which is why every helper here
 * reports "unknown" rather than guessing — an unusable verification channel must
 * never be reported as a definite yes or no.
 */

export interface AccountMemorySnapshotOk {
  known: true;
  entries: string[];
}

export interface AccountMemorySnapshotUnknown {
  known: false;
  reason: string;
}

export type AccountMemorySnapshot = AccountMemorySnapshotOk | AccountMemorySnapshotUnknown;

/** Minimal surface needed from a CDP session, so this is testable without Chrome. */
export interface PageEvaluator {
  evaluateAsync<T>(expression: string, timeoutMs?: number): Promise<T>;
}

/**
 * Runs in the authenticated page: the session token never leaves the browser and
 * is never returned to Oracle.
 */
const LIST_MEMORIES_SCRIPT = `(async () => {
  try {
    const s = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    if (!s.ok) return JSON.stringify({ known: false, reason: "session endpoint returned " + s.status });
    const token = (await s.json()).accessToken;
    if (!token) return JSON.stringify({ known: false, reason: "no access token in session" });
    const r = await fetch("/backend-api/memories", {
      headers: { accept: "application/json", authorization: "Bearer " + token }
    });
    if (!r.ok) return JSON.stringify({ known: false, reason: "memories endpoint returned " + r.status });
    const body = await r.json();
    if (!body || !Array.isArray(body.memories)) {
      return JSON.stringify({ known: false, reason: "memories endpoint returned an unexpected shape" });
    }
    return JSON.stringify({
      known: true,
      entries: body.memories
        .map((m) => (m && typeof m.content === "string" ? m.content : null))
        .filter((c) => c !== null)
    });
  } catch (e) {
    return JSON.stringify({ known: false, reason: String(e && e.message ? e.message : e) });
  }
})()`;

export async function readAccountMemories(
  page: PageEvaluator,
  timeoutMs = 30_000
): Promise<AccountMemorySnapshot> {
  let raw: string;
  try {
    raw = await page.evaluateAsync<string>(LIST_MEMORIES_SCRIPT, timeoutMs);
  } catch (error) {
    return {
      known: false,
      reason: `could not query the account: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  try {
    const parsed = JSON.parse(raw) as AccountMemorySnapshot;
    if (parsed && typeof parsed === "object" && "known" in parsed) return parsed;
    return { known: false, reason: "account query returned an unexpected payload" };
  } catch {
    return { known: false, reason: "account query returned unparseable JSON" };
  }
}

/** Saved Memory rewords entries, so containment is the usable comparison. */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function snapshotContains(snapshot: AccountMemorySnapshotOk, text: string): boolean {
  const needle = normalize(text);
  if (!needle) return false;
  return snapshot.entries.some((entry) => {
    const hay = normalize(entry);
    return hay === needle || hay.includes(needle) || needle.includes(hay);
  });
}

export type WriteVerification =
  | { verified: true }
  | { verified: false; conclusive: true }
  | { verified: false; conclusive: false; reason: string };

/**
 * Confirms an entry really reached Saved Memory.
 *
 * `conclusive: false` means the account could not be inspected — the caller must
 * report the write as unverified rather than as a success or a failure.
 */
export async function verifyAccountMemoryWrite(
  page: PageEvaluator,
  text: string,
  timeoutMs = 30_000
): Promise<WriteVerification> {
  const snapshot = await readAccountMemories(page, timeoutMs);
  if (!snapshot.known) return { verified: false, conclusive: false, reason: snapshot.reason };
  return snapshotContains(snapshot, text)
    ? { verified: true }
    : { verified: false, conclusive: true };
}

/** Mirror of {@link verifyAccountMemoryWrite} for deletions. */
export async function verifyAccountMemoryDeletion(
  page: PageEvaluator,
  text: string,
  timeoutMs = 30_000
): Promise<WriteVerification> {
  const snapshot = await readAccountMemories(page, timeoutMs);
  if (!snapshot.known) return { verified: false, conclusive: false, reason: snapshot.reason };
  return snapshotContains(snapshot, text)
    ? { verified: false, conclusive: true }
    : { verified: true };
}
