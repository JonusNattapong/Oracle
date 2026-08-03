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
    "textarea"
  ],
  sendButton: [
    "button[data-testid='send-button']",
    "button[data-testid='fruitjuice-send-button']",
    "button[aria-label*='Send']"
  ],
  stopButton: [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop']",
    ".result-streaming"
  ],
  completionAction: [
    "[data-testid='copy-turn-action-button']",
    "button[aria-label*='Copy']"
  ],
  responseContainer: [
    "[data-message-author-role='assistant'] .markdown",
    "article[data-turn='assistant'] .markdown",
    "article[data-testid^='conversation-turn-'] .markdown",
    "div.markdown",
    ".agent-turn .markdown"
  ],
  assistantTurn: [
    "[data-message-author-role='assistant']",
    "article[data-turn='assistant']",
    "article[data-testid^='conversation-turn-']:has([data-message-author-role='assistant'])",
    ".agent-turn"
  ],
  fileInput: [
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
  attachment: [
    "[data-testid*='attachment']",
    "[data-testid*='file-thumbnail']",
    "[data-testid*='image-thumbnail']",
    "button[aria-label*='Remove file' i]"
  ]
};
