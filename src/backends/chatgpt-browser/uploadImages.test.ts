import { describe, expect, test } from "vitest";
import { ResponseMonitor, type CdpClient } from "./response.js";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const IMAGES = [{ base64: PNG_BASE64, mimeType: "image/png", fileName: "shot.png" }];

/**
 * Composer stub.
 *
 * `leftover` is how many attachments the composer already holds when the upload
 * starts — the state a previous consult leaves behind when it fails mid-upload,
 * since Chrome keeps the profile between runs. `clearable` says whether the
 * remove control works.
 */
function fakeComposer(options: { leftover: number; clearable?: boolean }) {
  let attachments = options.leftover;
  const clearable = options.clearable ?? true;
  let injected = 0;
  const session: CdpClient = {
    async send<T>(): Promise<T> {
      return undefined as T;
    },
    // Matched on each script's own distinctive marker. The attachment selector
    // list is embedded in three of these scripts, so anything drawn from it —
    // "Remove file" included — appears in all three and cannot identify one.
    async evaluate<T>(expression: string): Promise<T> {
      // Injection: reports the baseline it measured just before adding files.
      if (expression.includes("DataTransfer")) {
        injected += IMAGES.length;
        attachments += IMAGES.length;
        return { success: true, baselineCount: attachments - IMAGES.length } as unknown as T;
      }
      // Polling for upload completion.
      if (expression.includes("matchedNames")) {
        return { count: attachments, busy: false, matchedNames: 0 } as unknown as T;
      }
      // clearComposerAttachments: clicks every remove control, returns the rest.
      if (expression.includes("buttons.forEach")) {
        if (clearable) attachments = 0;
        return attachments as unknown as T;
      }
      // Locating the file input.
      if (expression.includes("inputSelectors")) return true as unknown as T;
      return null as unknown as T;
    },
    async evaluateAsync<T>(): Promise<T> {
      return undefined as T;
    }
  };
  return { session, injectedCount: () => injected };
}

describe("uploadImages", () => {
  test("attaches an image to an empty composer", async () => {
    const { session } = fakeComposer({ leftover: 0 });
    await expect(new ResponseMonitor(session).uploadImages(IMAGES, 3_000)).resolves.toBeUndefined();
  });

  test("clears a stale attachment left by an earlier failed consult", async () => {
    // Without the clear, the baseline is 1, the wait needs a count of 2, the
    // composer only ever reaches 1, and the upload times out — then leaves the
    // composer dirty for the next run, which is why this failed intermittently
    // rather than consistently.
    const { session } = fakeComposer({ leftover: 1 });
    await expect(new ResponseMonitor(session).uploadImages(IMAGES, 3_000)).resolves.toBeUndefined();
  });

  test("still attempts the upload when the composer cannot be cleared", async () => {
    // Clearing is best-effort. A composer that will not clear must not turn into
    // a failure of its own before the upload has been tried.
    const { session, injectedCount } = fakeComposer({ leftover: 1, clearable: false });
    await new ResponseMonitor(session).uploadImages(IMAGES, 3_000).catch(() => undefined);
    expect(injectedCount()).toBe(1);
  });

  test("does nothing when there are no images", async () => {
    const { session, injectedCount } = fakeComposer({ leftover: 0 });
    await new ResponseMonitor(session).uploadImages([], 3_000);
    expect(injectedCount()).toBe(0);
  });
});
