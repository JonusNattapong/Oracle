import type { SelectorMap } from "./types.js";

/**
 * Keep multiple semantic fallbacks because ChatGPT's DOM is not a public API.
 * Tests should exercise the stable data attributes first.
 */
export const CHATGPT_SELECTORS: SelectorMap = {
  promptInput: [
    "#prompt-textarea",
    "textarea[data-id='root']",
    "div[contenteditable='true']",
    "textarea",
    "[role='textbox']",
    "div[aria-label*='Prompt' i]"
  ],
  sendButton: [
    "button[data-testid='send-button']",
    "button[data-testid='fruitjuice-send-button']",
    "button[aria-label*='Send' i]",
    "button[aria-label*='Submit' i]",
    "button[type='submit']"
  ],
  stopButton: [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop' i]",
    ".result-streaming"
  ],
  completionAction: [
    "[data-testid='copy-turn-action-button']",
    "button[aria-label*='Copy' i]"
  ],
  responseContainer: [
    "[data-message-author-role='assistant'] .markdown",
    "article[data-turn='assistant'] .markdown",
    "article[data-testid^='conversation-turn-'] .markdown",
    "div.markdown",
    ".agent-turn .markdown",
    "[role='article'] .markdown"
  ],
  assistantTurn: [
    "[data-message-author-role='assistant']",
    "article[data-turn='assistant']",
    "article[data-testid^='conversation-turn-']:has([data-message-author-role='assistant'])",
    ".agent-turn",
    "[role='article']"
  ],
  /**
   * The composer's own file input.
   *
   * Probed against the live page on 2026-08-07: it carries **five** file
   * inputs. Only one sits inside the composer form, and that one declares no
   * `accept` attribute. The other four belong to the photo picker and the
   * image-generation modal (`upload-photos-input`,
   * `image-gen-action-modal-upload-photos`, `-upload-camera`) and every one of
   * them declares `accept="image/*"`.
   *
   * So `input[type='file'][accept*='image']` — the previous first choice —
   * resolved to the photo picker's input, outside the composer, and files were
   * being handed to an element the composer does not read. Attachments
   * sometimes appeared anyway, which is why this surfaced as an intermittent
   * upload timeout rather than a clean failure. Scoping to the form is what
   * makes the match the right element rather than merely the first one.
   */
  fileInput: [
    "form input[type='file']",
    "input[type='file'][accept*='image']",
    "input[type='file'][multiple]",
    "input[type='file']"
  ],
  attachButton: [
    "button[data-testid='composer-plus-btn']",
    "button[aria-label*='Attach' i]",
    "button[aria-label*='Add photos' i]",
    "button[aria-label*='Upload' i]"
  ],
  /**
   * Items in the composer's plus menu (Add photos, Create image, Web search,
   * Deep research). They carry no data-testid and no menuitem role — the class
   * plus the visible label is the only handle available.
   */
  composerMenuItem: [
    "div.__menu-item",
    "[role='menuitem']",
    "[role='option']"
  ],
  /**
   * Handles on an attached-but-not-yet-sent file. Probed against the live
   * composer on 2026-08-07: all three `data-testid` alternates matched zero
   * elements and only the remove control's aria-label resolved, so upload
   * completion was being detected by the last fallback in the list. The order
   * here now reflects what actually matches; the testids are kept in case they
   * return.
   */
  attachment: [
    "button[aria-label*='Remove file' i]",
    "[data-testid*='attachment']",
    "[data-testid*='file-thumbnail']",
    "[data-testid*='image-thumbnail']"
  ],
  modelSelector: [
    "button[data-testid='model-selector-button']",
    "button[aria-haspopup='menu'][aria-label*='Model' i]",
    "button[aria-label*='ChatGPT' i]",
    "button[aria-haspopup='menu']"
  ],
  cloudflareChallenge: [
    "#challenge-running",
    ".cf-turnstile",
    "#turnstile-wrapper",
    "iframe[src*='challenges.cloudflare.com']"
  ]
};
