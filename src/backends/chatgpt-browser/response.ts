import WebSocket from "ws";
import { CHATGPT_SELECTORS } from "./selectors.js";
import type { BrowserImagePayload } from "./types.js";

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ResponseBaseline {
  count: number;
  lastText: string;
  assistantTurnCount?: number;
  assistantImageCount?: number;
}

export interface CdpClient {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T>;
  evaluate<T>(expression: string): Promise<T>;
  evaluateAsync<T>(expression: string, timeoutMs?: number): Promise<T>;
}

export interface ChatGptAuthenticationStatus {
  authenticated: boolean;
  detail: string;
}

export class CdpSession implements CdpClient {
  private readonly ws: WebSocket;
  private messageId = 0;
  private readonly pending = new Map<number, PendingCommand>();

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket connection to ${this.ws.url} timed out`));
      }, timeoutMs);

      this.ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });

      this.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as {
            id?: number;
            error?: { code?: number; message?: string };
            result?: unknown;
          };
          if (message.id === undefined) return;
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            pending.reject(
              new Error(`CDP Error ${message.error.code ?? "unknown"}: ${message.error.message ?? "unknown"}`)
            );
          } else {
            pending.resolve(message.result);
          }
        } catch {
          // Ignore CDP events and malformed messages that are not command replies.
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(timer);
        this.rejectPending(error);
        reject(error);
      });

      this.ws.on("close", () => {
        this.rejectPending(new Error("Chrome DevTools connection closed."));
      });
    });
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Chrome DevTools connection is not open."));
        return;
      }
      const id = ++this.messageId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{
      exceptionDetails?: unknown;
      result?: { value?: T };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false
    });
    if (response.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${JSON.stringify(response.exceptionDetails)}`);
    }
    return response.result?.value as T;
  }

  async evaluateAsync<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    const response = await this.send<{
      exceptionDetails?: unknown;
      result?: { value?: T };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${JSON.stringify(response.exceptionDetails)}`);
    }
    return response.result?.value as T;
  }

  close(): void {
    this.rejectPending(new Error("Chrome DevTools session closed."));
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class ResponseMonitor {
  constructor(private readonly session: CdpClient) {}

  async navigateToChatGPT(
    destinationOrTimeout: string | number = "https://chatgpt.com",
    timeoutMs = 60_000,
    navigate = true
  ): Promise<void> {
    const destination = typeof destinationOrTimeout === "string"
      ? destinationOrTimeout
      : "https://chatgpt.com";
    if (typeof destinationOrTimeout === "number") {
      timeoutMs = destinationOrTimeout;
    }
    const safeDestination = normalizeChatGptUrl(destination);
    const expectedConversationUrl = normalizeChatGptConversationUrl(safeDestination);
    const expectedRoot = !expectedConversationUrl;
    await this.session.send("Page.enable");
    await this.session.send("Runtime.enable");
    if (navigate) {
      await this.session.send("Page.navigate", { url: safeDestination });
    }

    const selectors = JSON.stringify(CHATGPT_SELECTORS.promptInput);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = await this.session.evaluate<{ ready: boolean; url: string }>(`
        (function() {
          const selectors = ${selectors};
          return {
            ready: document.readyState !== "loading"
              && selectors.some((selector) => Boolean(document.querySelector(selector))),
            url: window.location.href
          };
        })()
      `);
      const currentConversationUrl = normalizeChatGptConversationUrl(state.url);
      const location = (() => {
        try {
          const current = new URL(state.url);
          return {
            onChatGpt: current.protocol === "https:"
              && (current.hostname === "chatgpt.com" || current.hostname === "chat.openai.com"),
            atRoot: current.pathname === "/"
          };
        } catch {
          return { onChatGpt: false, atRoot: false };
        }
      })();
      if (
        state.ready
        && location.onChatGpt
        && (
          expectedConversationUrl
            ? currentConversationUrl === expectedConversationUrl
            : expectedRoot && location.atRoot
        )
      ) {
        return;
      }
      await delay(500);
    }
    throw new Error(
      expectedConversationUrl
        ? "The saved ChatGPT conversation did not open. It may have been deleted or become unavailable."
        : "ChatGPT prompt input was not found. Complete login in `oracle browser setup` and try again."
    );
  }

  async currentConversationUrl(): Promise<string | undefined> {
    const currentUrl = await this.session.evaluate<string>("window.location.href");
    return normalizeChatGptConversationUrl(currentUrl);
  }

  async authenticationStatus(): Promise<ChatGptAuthenticationStatus> {
    const result = await this.session.send<{
      cookies?: Array<{ name?: string }>;
    }>("Network.getCookies", {
      urls: ["https://chatgpt.com", "https://chat.openai.com"]
    });
    const cookieNames = (result.cookies ?? [])
      .map((cookie) => cookie.name ?? "")
      .filter(Boolean);
    const hasSessionCookie = cookieNames.some(
      (name) =>
        /session-token/i.test(name)
        || /auth[_-]?session/i.test(name)
    );
    if (hasSessionCookie) {
      return {
        authenticated: true,
        detail: "ChatGPT account session detected in the isolated Oracle profile."
      };
    }

    const controls = await this.session.evaluate<{
      hasAccountControl: boolean;
      hasLoginControl: boolean;
    }>(`
      (function() {
        const visible = (element) => Boolean(
          element
          && element.getClientRects().length > 0
          && getComputedStyle(element).display !== "none"
          && getComputedStyle(element).visibility !== "hidden"
        );
        const account = document.querySelector(
          '[data-testid="profile-button"],'
          + '[data-testid="accounts-profile-button"],'
          + 'button[aria-label*="account" i],'
          + 'button[aria-label*="profile" i]'
        );
        const login = document.querySelector(
          '[data-testid="login-button"],[data-testid="signup-button"]'
        );
        return {
          hasAccountControl: visible(account),
          hasLoginControl: visible(login)
        };
      })()
    `);
    return controls.hasAccountControl && !controls.hasLoginControl
      ? {
          authenticated: true,
          detail: "ChatGPT account controls detected in the isolated Oracle profile."
        }
      : {
          authenticated: false,
          detail: "No ChatGPT account session detected; the page is running in guest mode."
        };
  }

  /**
   * Clicks at viewport coordinates through the browser's own input pipeline.
   *
   * The composer menu does not respond to `element.click()` or synthesised
   * pointer events — it opens only for trusted input — so selecting a tool has
   * to go through Input.dispatchMouseEvent rather than the DOM.
   */
  private async clickAt(x: number, y: number): Promise<void> {
    const px = Math.round(x);
    const py = Math.round(y);
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, buttons: 0 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1
    });
    await new Promise((resolve) => setTimeout(resolve, 90));
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1
    });
  }

  private async centreOf(script: string): Promise<{ x: number; y: number } | null> {
    return this.session.evaluate<{ x: number; y: number } | null>(
      `(() => {
         const el = ${script};
         if (!el) return null;
         const r = el.getBoundingClientRect();
         if (r.width === 0 && r.height === 0) return null;
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
       })()`
    );
  }

  /** Opens the composer's plus menu. Returns false if the button is not there. */
  async openComposerMenu(): Promise<boolean> {
    const plusSelector = CHATGPT_SELECTORS.attachButton
      .map((sel) => `document.querySelector(${JSON.stringify(sel)})`)
      .join(" || ");
    const plus = await this.centreOf(`(${plusSelector})`);
    if (!plus) return false;
    await this.clickAt(plus.x, plus.y);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return true;
  }

  /**
   * Closes the composer menu, leaving the composer as it was found.
   *
   * Escape alone did not dismiss it, so the click that does is used instead:
   * the prompt input is always present and clicking it is harmless.
   */
  async closeComposerMenu(): Promise<void> {
    for (const type of ["keyDown", "keyUp"] as const) {
      await this.session.send("Input.dispatchKeyEvent", {
        type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    const promptSelector = CHATGPT_SELECTORS.promptInput
      .map((sel) => `document.querySelector(${JSON.stringify(sel)})`)
      .join(" || ");
    const input = await this.centreOf(`(${promptSelector})`);
    if (input) await this.clickAt(input.x, input.y);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  /**
   * Waits for the composer menu to list its entries.
   *
   * The class the entries carry is shared with other menus in the page, so an
   * early read returns those instead and looks like an empty tool menu.
   */
  async waitForComposerMenuItems(timeoutMs = 5_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    let items: string[] = [];
    while (Date.now() < deadline) {
      items = await this.listComposerMenuItems();
      if (items.some((item) => /^(add photos|create image|web search|deep research)/i.test(item))) {
        return items;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return items;
  }

  /** Labels currently listed in the composer menu. Requires the menu to be open. */
  async listComposerMenuItems(): Promise<string[]> {
    const itemSelector = CHATGPT_SELECTORS.composerMenuItem
      .map((sel) => `document.querySelectorAll(${JSON.stringify(sel)})`)
      .join(", ...");
    return this.session.evaluate<string[]>(
      `Array.from([...${itemSelector}])
         .map((n) => (n.textContent || "").trim())
         .filter((t) => t.length > 0 && t.length < 60)`
    );
  }

  /**
   * Turns on a composer tool (currently Web search) for the next message.
   *
   * Returns only after confirming the composer shows the tool's pill: clicking
   * the menu entry is not evidence it engaged, and answering a question that was
   * supposed to search the web without having searched is worse than failing.
   */
  async selectComposerTool(label: string, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    // ChatGPT keeps the tool switched on across navigations, so it may already
    // be active — but the composer renders about six seconds after the page
    // loads, and asking before that reports "off" for a tool that is on. Turning
    // it on again stacks another pill onto the composer, so wait for the
    // composer itself rather than guessing a delay.
    await this.waitForComposerReady();
    if (await this.isComposerToolActive(label)) return true;

    if (!await this.openComposerMenu()) return false;

    const itemSelector = CHATGPT_SELECTORS.composerMenuItem
      .map((sel) => `document.querySelectorAll(${JSON.stringify(sel)})`)
      .join(", ...");
    const item = await this.centreOf(
      `Array.from([...${itemSelector}]).find((n) =>
         (n.textContent || "").trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}))`
    );
    if (!item) {
      // Leave the composer as it was found rather than with a menu hanging open.
      await this.session.evaluate("document.activeElement && document.activeElement.blur()");
      return false;
    }
    await this.clickAt(item.x, item.y);

    while (Date.now() < deadline) {
      if (await this.isComposerToolActive(label)) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  /**
   * Waits until the composer has actually rendered. Its contents appear several
   * seconds after the page reports loaded, and an empty composer is
   * indistinguishable from one with no tool selected.
   */
  async waitForComposerReady(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.session.evaluate<boolean>(
        `(() => {
           const form = document.querySelector("form");
           return !!form && ((form.innerText || "").trim().length > 0);
         })()`
      );
      if (ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  }

  /** True when the composer displays the tool's pill. */
  async isComposerToolActive(label: string): Promise<boolean> {
    return this.session.evaluate<boolean>(
      `(() => {
         const form = document.querySelector("form");
         const text = (form && form.innerText) || "";
         return text.toLowerCase().includes(${JSON.stringify(label.toLowerCase())});
       })()`
    );
  }

  async uploadImages(images: BrowserImagePayload[], timeoutMs = 60_000): Promise<void> {
    if (images.length === 0) return;
    const fileInputSelectors = JSON.stringify(CHATGPT_SELECTORS.fileInput);
    const attachButtonSelectors = JSON.stringify(CHATGPT_SELECTORS.attachButton);
    const attachmentSelectors = JSON.stringify(CHATGPT_SELECTORS.attachment);
    const encodedImages = JSON.stringify(images);

    const locateInputScript = `
      (function() {
        const inputSelectors = ${fileInputSelectors};
        for (const selector of inputSelectors) {
          const input = document.querySelector(selector);
          if (input) return true;
        }
        return false;
      })()
    `;
    let inputFound = await this.session.evaluate<boolean>(locateInputScript);
    if (!inputFound) {
      await this.session.evaluate<boolean>(`
        (function() {
          const selectors = ${attachButtonSelectors};
          for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (button && !button.disabled) {
              button.click();
              return true;
            }
          }
          return false;
        })()
      `);
    }

    const inputStarted = Date.now();
    while (!inputFound && Date.now() - inputStarted < 5_000) {
      inputFound = await this.session.evaluate<boolean>(locateInputScript);
      if (inputFound) break;
      await this.session.evaluate<boolean>(`
        (function() {
          const candidates = Array.from(document.querySelectorAll('[role="menuitem"],button'));
          const upload = candidates.find((candidate) =>
            /upload|photo|file/i.test(candidate.textContent || "")
          );
          if (!upload) return false;
          upload.click();
          return true;
        })()
      `);
      await delay(250);
    }

    const result = await this.session.evaluate<{
      success: boolean;
      reason?: string;
      baselineCount?: number;
    }>(`
      (function() {
        const inputSelectors = ${fileInputSelectors};
        const attachmentSelectors = ${attachmentSelectors};
        let input = null;
        for (const selector of inputSelectors) {
          input = document.querySelector(selector);
          if (input) break;
        }
        if (!(input instanceof HTMLInputElement)) {
          return { success: false, reason: "ChatGPT image file input was not found." };
        }
        const scope = input.closest("form") || input.parentElement || document;
        const existing = new Set();
        for (const selector of attachmentSelectors) {
          for (const element of scope.querySelectorAll(selector)) existing.add(element);
        }
        const transfer = new DataTransfer();
        for (const image of ${encodedImages}) {
          const binary = atob(image.base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
          }
          transfer.items.add(new File([bytes], image.fileName, { type: image.mimeType }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true, baselineCount: existing.size };
      })()
    `);
    if (!result?.success || result.baselineCount === undefined) {
      throw new Error(result?.reason ?? "Failed to attach images to ChatGPT.");
    }

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await this.session.evaluate<{
        count: number;
        busy: boolean;
        matchedNames: number;
      }>(`
        (function() {
          const inputSelectors = ${fileInputSelectors};
          const attachmentSelectors = ${attachmentSelectors};
          let input = null;
          for (const selector of inputSelectors) {
            input = document.querySelector(selector);
            if (input) break;
          }
          const scope = input?.closest("form") || input?.parentElement || document;
          const attachments = new Set();
          for (const selector of attachmentSelectors) {
            for (const element of scope.querySelectorAll(selector)) attachments.add(element);
          }
          const text = [
            scope.innerText || "",
            ...Array.from(scope.querySelectorAll("img")).map((image) => image.alt || "")
          ].join("\\n").toLowerCase();
          const names = ${JSON.stringify(images.map((image) => image.fileName.toLowerCase()))};
          const matchedNames = names.filter((name) => {
            const stem = name.replace(/\\.[^.]+$/, "");
            return text.includes(name) || (stem.length >= 3 && text.includes(stem));
          }).length;
          const busy = Boolean(scope.querySelector(
            '[aria-busy="true"],[role="progressbar"],[data-testid*="progress"],[data-state="loading"]'
          )) || /uploading/i.test(scope.innerText || "");
          return { count: attachments.size, busy, matchedNames };
        })()
      `);
      if (
        !status.busy
        && (
          status.count >= result.baselineCount + images.length
          || status.matchedNames === images.length
        )
      ) {
        return;
      }
      await delay(500);
    }
    throw new Error("ChatGPT image attachments did not finish uploading before the timeout.");
  }

  async captureAssistantImages(): Promise<{
    images: BrowserImagePayload[];
    warnings: string[];
  }> {
    const assistantSelectors = JSON.stringify(CHATGPT_SELECTORS.assistantTurn);
    return await this.session.evaluateAsync<{
      images: BrowserImagePayload[];
      warnings: string[];
    }>(`
      (async function() {
        const assistantSelectors = ${assistantSelectors};
        let turns = [];
        for (const selector of assistantSelectors) {
          const found = Array.from(document.querySelectorAll(selector));
          if (found.length > 0) {
            turns = found;
            break;
          }
        }
        const turn = turns[turns.length - 1];
        if (!turn) return { images: [], warnings: [] };
        const seenSources = new Set();
        const candidates = Array.from(turn.querySelectorAll("img"))
          .filter((image) => {
            const source = image.currentSrc || image.src;
            if (
              !source
              || (image.naturalWidth < 128 && image.naturalHeight < 128)
              || seenSources.has(source)
            ) return false;
            // Third-party images in an answer are citation chrome, not content
            // the assistant produced: web-search and deep-research answers embed
            // 128x128 favicons from the sites they cite. They are also
            // unfetchable from this origin, so every one became a "Failed to
            // fetch" warning about an image nobody wanted saved.
            try {
              const url = new URL(source, location.href);
              if (url.protocol !== "blob:" && url.protocol !== "data:"
                  && url.origin !== location.origin) return false;
            } catch { return false; }
            seenSources.add(source);
            return true;
          })
          .slice(0, 9);
        const images = [];
        const warnings = [];
        for (const [index, image] of candidates.entries()) {
          try {
            const source = image.currentSrc || image.src;
            const response = await fetch(source, { credentials: "include" });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const declaredLength = Number(response.headers.get("content-length") || "0");
            if (declaredLength > 10485760) throw new Error("image exceeds 10 MiB");
            const blob = await response.blob();
            if (blob.size > 10485760) throw new Error("image exceeds 10 MiB");
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ""));
              reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
              reader.readAsDataURL(blob);
            });
            const comma = dataUrl.indexOf(",");
            if (comma < 0) throw new Error("invalid image data URL");
            images.push({
              base64: dataUrl.slice(comma + 1),
              mimeType: blob.type || dataUrl.slice(5, dataUrl.indexOf(";")),
              fileName: "generated-" + String(index + 1),
              alt: (image.alt || "").slice(0, 300)
            });
          } catch (error) {
            warnings.push(
              "Could not capture assistant image " + String(index + 1) + ": "
              + (error instanceof Error ? error.message : String(error))
            );
          }
        }
        if (candidates.length > 8) {
          warnings.push("Only the first 8 assistant images are retained.");
        }
        return { images: images.slice(0, 8), warnings };
      })()
    `, 120_000);
  }


  async fillPromptAndSend(promptText: string): Promise<ResponseBaseline> {
    const inputSelectors = JSON.stringify(CHATGPT_SELECTORS.promptInput);
    const sendSelectors = JSON.stringify(CHATGPT_SELECTORS.sendButton);
    const responseSelectors = JSON.stringify(CHATGPT_SELECTORS.responseContainer);
    const assistantSelectors = JSON.stringify(CHATGPT_SELECTORS.assistantTurn);
    const encodedPrompt = JSON.stringify(promptText);

    const script = `
      (function() {
        const inputSelectors = ${inputSelectors};
        const responseSelectors = ${responseSelectors};
        const assistantSelectors = ${assistantSelectors};

        const responseElements = (() => {
          for (const selector of responseSelectors) {
            const found = Array.from(document.querySelectorAll(selector));
            if (found.length > 0) return found;
          }
          return [];
        })();
        let assistantTurns = [];
        for (const selector of assistantSelectors) {
          assistantTurns = Array.from(document.querySelectorAll(selector));
          if (assistantTurns.length > 0) break;
        }
        const assistantImageSources = new Set();
        for (const turn of assistantTurns) {
          for (const image of turn.querySelectorAll("img")) {
            const source = image.currentSrc || image.src;
            if (
              source
              && (image.naturalWidth >= 128 || image.naturalHeight >= 128)
            ) assistantImageSources.add(source);
          }
        }
        const baseline = {
          count: responseElements.length,
          assistantTurnCount: assistantTurns.length,
          assistantImageCount: assistantImageSources.size,
          lastText: responseElements.length
            ? (responseElements[responseElements.length - 1].innerText
              || responseElements[responseElements.length - 1].textContent
              || "").trim()
            : ""
        };

        let input = null;
        for (const selector of inputSelectors) {
          input = document.querySelector(selector);
          if (input) break;
        }
        if (!input) {
          return { success: false, reason: "Prompt input not found. Verify that ChatGPT login is complete." };
        }

        input.focus();
        const prompt = ${encodedPrompt};
        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
          const prototype = input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          setter?.call(input, prompt);
          input.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: prompt
          }));
        } else {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(input);
          selection?.removeAllRanges();
          selection?.addRange(range);
          const inserted = document.execCommand("insertText", false, prompt);
          if (!inserted) {
            input.replaceChildren(document.createTextNode(prompt));
            input.dispatchEvent(new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: prompt
            }));
          }
        }

        return { success: true, baseline };
      })()
    `;

    const result = await this.session.evaluate<{
      success: boolean;
      reason?: string;
      baseline?: ResponseBaseline;
    }>(script);
    if (!result?.success || !result.baseline) {
      throw new Error(result?.reason ?? "Failed to insert the prompt in ChatGPT.");
    }

    const clickSendScript = `
      (function() {
        const sendSelectors = ${sendSelectors};
        let button = null;
        for (const selector of sendSelectors) {
          const candidate = document.querySelector(selector);
          if (candidate && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true") {
            button = candidate;
            break;
          }
        }
        if (!button) return false;
        button.click();
        return true;
      })()
    `;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await this.session.evaluate<boolean>(clickSendScript)) {
        return result.baseline;
      }
      await delay(100);
    }

    const pressEnterScript = `
      (function() {
        const inputSelectors = ${inputSelectors};
        let input = null;
        for (const selector of inputSelectors) {
          input = document.querySelector(selector);
          if (input) break;
        }
        if (!input) return false;
        for (const type of ["keydown", "keypress", "keyup"]) {
          input.dispatchEvent(new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true
          }));
        }
        return true;
      })()
    `;
    const pressed = await this.session.evaluate<boolean>(pressEnterScript);
    if (!pressed) {
      throw new Error("Failed to find the ChatGPT prompt input while submitting.");
    }
    return result.baseline;
  }

  async waitForResponse(
    baseline: ResponseBaseline,
    timeoutMs = 180_000,
    options: { allowStallReload?: boolean } = {}
  ): Promise<string> {
    // Reloading rescues a UI that stopped streaming, but it also abandons work
    // in progress. A long silent stretch is normal for deep research, where the
    // turn sits unchanged for minutes while the model works, so callers running
    // one must be able to turn the recovery off.
    const allowStallReload = options.allowStallReload ?? true;
    const started = Date.now();
    let lastText = "";
    let responseStarted = false;
    let quietPolls = 0;
    let attemptedReloadRecovery = false;

    const stopSelectors = JSON.stringify(CHATGPT_SELECTORS.stopButton);
    const completionSelectors = JSON.stringify(CHATGPT_SELECTORS.completionAction);
    const responseSelectors = JSON.stringify(CHATGPT_SELECTORS.responseContainer);
    const assistantSelectors = JSON.stringify(CHATGPT_SELECTORS.assistantTurn);

    const checkScript = `
      (function() {
        const stopSelectors = ${stopSelectors};
        const completionSelectors = ${completionSelectors};
        const responseSelectors = ${responseSelectors};
        const assistantSelectors = ${assistantSelectors};
        const isStreaming = stopSelectors.some((selector) => Boolean(document.querySelector(selector)));
        let elements = [];
        for (const selector of responseSelectors) {
          elements = Array.from(document.querySelectorAll(selector));
          if (elements.length > 0) break;
        }
        const element = elements[elements.length - 1];
        let assistantTurns = [];
        for (const selector of assistantSelectors) {
          assistantTurns = Array.from(document.querySelectorAll(selector));
          if (assistantTurns.length > 0) break;
        }
        const turn = element?.closest('[data-testid^="conversation-turn-"]')
          || element?.closest('article[data-turn="assistant"]')
          || element?.closest('[data-message-author-role="assistant"]')
          || assistantTurns[assistantTurns.length - 1];
        const imageSources = new Set();
        for (const image of turn?.querySelectorAll("img") || []) {
          const source = image.currentSrc || image.src;
          if (
            source
            && (image.naturalWidth >= 128 || image.naturalHeight >= 128)
          ) imageSources.add(source);
        }
        const hasCompletionAction = Boolean(
          turn
          && completionSelectors.some((selector) => turn.querySelector(selector))
        );
        return {
          isStreaming,
          hasCompletionAction,
          count: elements.length,
          assistantTurnCount: assistantTurns.length,
          assistantImageCount: imageSources.size,
          text: element ? (element.innerText || element.textContent || "").trim() : ""
        };
      })()
    `;

    while (Date.now() - started < timeoutMs) {
      let status: {
        isStreaming: boolean;
        hasCompletionAction?: boolean;
        count: number;
        assistantTurnCount?: number;
        assistantImageCount?: number;
        text: string;
      };
      try {
        status = await this.session.evaluate(checkScript);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /Promise was collected|Execution context was destroyed|Cannot find context/i.test(message)
          && Date.now() - started < timeoutMs
        ) {
          await delay(500);
          continue;
        }
        throw error;
      }

      if (
        status.count > baseline.count
        || (status.assistantTurnCount ?? 0) > (baseline.assistantTurnCount ?? 0)
        || (status.assistantImageCount ?? 0) > (baseline.assistantImageCount ?? 0)
        || (status.text !== "" && status.text !== baseline.lastText)
        || status.isStreaming
      ) {
        responseStarted = true;
      }

      if (
        responseStarted
        && !status.isStreaming
        && status.hasCompletionAction
        && (
          Boolean(status.text)
          || (status.assistantImageCount ?? 0) > (baseline.assistantImageCount ?? 0)
        )
      ) {
        return status.text
          || `[ChatGPT returned ${status.assistantImageCount ?? 1} image(s)]`;
      }

      if (responseStarted && status.text) {
        quietPolls = status.text === lastText && !status.isStreaming
          ? quietPolls + 1
          : 0;
        lastText = status.text;
      }
      if (allowStallReload && quietPolls >= 30 && !attemptedReloadRecovery) {
        attemptedReloadRecovery = true;
        quietPolls = 0;
        await this.session.send("Page.reload", { ignoreCache: false });
        await delay(1_000);
        continue;
      }
      await delay(1_000);
    }

    if (responseStarted && lastText) {
      throw new Error(
        `ChatGPT response did not expose a completion control within ${timeoutMs}ms; refusing to return a partial answer.`
      );
    }
    throw new Error(`ChatGPT response stream timed out after ${timeoutMs}ms.`);
  }
}

export function normalizeChatGptConversationUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com")
      || !/^\/c\/[a-z0-9-]+\/?$/i.test(url.pathname)
    ) {
      return undefined;
    }
    return `https://chatgpt.com${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
}

function normalizeChatGptUrl(value: string): string {
  if (value === "https://chatgpt.com" || value === "https://chatgpt.com/") {
    return "https://chatgpt.com";
  }
  const conversationUrl = normalizeChatGptConversationUrl(value);
  if (!conversationUrl) {
    throw new Error("Refusing to navigate Browser Mode outside a saved ChatGPT conversation.");
  }
  return conversationUrl;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
