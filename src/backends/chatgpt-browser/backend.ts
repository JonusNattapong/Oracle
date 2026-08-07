import path from "node:path";
import type {
  AccountMemoryVerification,
  DoctorCheck,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  ExecutionBackendRequest,
  ExecutionBackendResponse
} from "../backend.js";
import {
  COMPOSER_TOOL_LABELS,
  COMPOSER_TOOL_MIN_TIMEOUT_MS,
  COMPOSER_TOOLS_WITHOUT_STALL_RELOAD,
  type ChatGptBrowserConfig
} from "./types.js";
import {
  ChromeLauncher,
  ensureWindowNotMinimized,
  findOrCreatePageTarget,
  withConsultLock
} from "./chrome.js";
import {
  CdpSession,
  normalizeChatGptConversationUrl,
  ResponseMonitor
} from "./response.js";
import { ChatGptStreamReader } from "./stream.js";
import { BrowserDiagnostics } from "./diagnostics.js";
import { OracleError } from "../../errors.js";
import { estimateTokens } from "../../tokens.js";
import {
  buildAccountMemoryPrompt,
  isAccountMemorySaveConfirmed
} from "./accountMemory.js";
import {
  readAccountMemories,
  verifyAccountMemoryWrite,
  type AccountMemorySnapshot
} from "./accountMemoryApi.js";
import {
  persistBrowserImages,
  validateBrowserImage
} from "./imageArtifacts.js";
import type { BrowserImagePayload } from "./types.js";

function stripInlineImageDataUrls(prompt: string): string {
  return prompt.replace(
    /!\[([^\]]*)\]\(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+\)/gi,
    (_match, alt: string) => `[attached image: ${alt || "image"}]`
  );
}

export class ChatGptBrowserBackend implements ExecutionBackend {
  readonly id = "chatgpt-browser";
  readonly capabilities: ExecutionBackendCapabilities = Object.freeze({
    consult: true,
    toolUse: false,
    images: true,
    continuation: true,
    accountMemory: true,
    composerTools: true,
    structuredUsage: false,
    supportedPlatforms: Object.freeze(["darwin" as NodeJS.Platform, "linux" as NodeJS.Platform, "win32" as NodeJS.Platform])
  });

  private diagnostics = new BrowserDiagnostics();

  constructor(private readonly config: ChatGptBrowserConfig) {}

  async healthCheck(): Promise<DoctorCheck[]> {
    return this.diagnostics.runDoctor(this.config);
  }

  /**
   * Reads Saved Memory from the account itself rather than by asking ChatGPT to
   * describe it. The conversational route has been observed answering "no
   * memories" for an account holding four, so it cannot be used to decide what
   * is stored. Returns `known: false` when the account cannot be inspected —
   * never an empty list standing in for an unknown one.
   */
  async listAccountMemories(): Promise<AccountMemorySnapshot> {
    if (!this.config.enabled) {
      return { known: false, reason: "browser mode is disabled" };
    }
    const launcher = new ChromeLauncher();
    let session: CdpSession | undefined;
    try {
      const processInfo = await launcher.launch(this.config);
      const target = await findOrCreatePageTarget(processInfo.port);
      if (!target.webSocketDebuggerUrl) {
        return { known: false, reason: "target page exposes no debugger URL" };
      }
      await ensureWindowNotMinimized(processInfo.port, target.id, async (wsUrl) => {
        const browserSession = new CdpSession(wsUrl);
        await browserSession.connect(5_000);
        return {
          send: (method, params, timeoutMs) => browserSession.send(method, params, timeoutMs),
          close: () => browserSession.close()
        };
      });
      session = new CdpSession(target.webSocketDebuggerUrl);
      await session.connect();
      await new ResponseMonitor(session).navigateToChatGPT("https://chatgpt.com", 60_000);
      return await readAccountMemories(session);
    } catch (error) {
      return {
        known: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    } finally {
      session?.close();
    }
  }

  /**
   * Locked for the full request, retries included: see `withConsultLock` in
   * chrome.ts for why. Concurrent callers on the same profile queue rather
   * than run — there is one ChatGPT tab, not one per caller.
   */
  async run(request: ExecutionBackendRequest): Promise<ExecutionBackendResponse> {
    return withConsultLock(this.config.profileDir, () => this.runLocked(request));
  }

  private async runLocked(request: ExecutionBackendRequest): Promise<ExecutionBackendResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.runOnce(request);
      } catch (error) {
        lastError = error;
        const classification = classifyBrowserError(error);
        if (classification === "permanent" || attempt === 2) {
          throw error;
        }
        console.warn(`[chatgpt-browser] retrying attempt ${attempt + 2}/3 after ${classification} failure`);
        await delay(attempt === 0 ? 2_000 : 5_000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async runOnce(request: ExecutionBackendRequest): Promise<ExecutionBackendResponse> {
    const supported: NodeJS.Platform[] = ["darwin", "linux", "win32"];
    if (!supported.includes(process.platform)) {
      throw new OracleError(
        "ORACLE_BROWSER_UNSUPPORTED_PLATFORM",
        `ChatGPT Browser Mode is not supported on platform: ${process.platform}`,
        "Run this backend on macOS, Linux, or Windows with a GUI session."
      );
    }
    if (!this.config.enabled) {
      throw new OracleError(
        "ORACLE_BROWSER_MODE_DISABLED",
        "ChatGPT Browser Mode is experimental and must be enabled explicitly.",
        "Set experimental.browserMode to true in .oracle/config.json."
      );
    }

    const uploadImages: BrowserImagePayload[] = (request.images ?? []).map((image, index) => {
      const validated = validateBrowserImage({
        ...image,
        fileName: image.fileName || `image-${index + 1}`
      });
      return {
        base64: validated.data.toString("base64"),
        mimeType: validated.mimeType,
        fileName: validated.fileName
      };
    });

    const launcher = new ChromeLauncher();
    let session: CdpSession | undefined;

    try {
      const processInfo = await launcher.launch(this.config);
      const target = await findOrCreatePageTarget(processInfo.port);
      if (!target.webSocketDebuggerUrl) {
        throw new Error("Target page does not expose a WebSocket debugger URL.");
      }

      // A minimized window has a frozen renderer, which answers no page-domain
      // command. Repair it before connecting rather than letting every call time
      // out with no indication of why.
      await ensureWindowNotMinimized(processInfo.port, target.id, async (wsUrl) => {
        const browserSession = new CdpSession(wsUrl);
        await browserSession.connect(5_000);
        return {
          send: (method, params, timeoutMs) => browserSession.send(method, params, timeoutMs),
          close: () => browserSession.close()
        };
      });

      session = new CdpSession(target.webSocketDebuggerUrl);
      await session.connect();

      const monitor = new ResponseMonitor(session);
      const conversationUrl = request.previousResponseId
        ? normalizeChatGptConversationUrl(request.previousResponseId)
        : undefined;
      if (request.previousResponseId && !conversationUrl) {
        throw new Error("Saved ChatGPT continuation URL is invalid or is not a ChatGPT conversation.");
      }
      const targetConversationUrl = normalizeChatGptConversationUrl(target.url);
      const alreadyOnConversation = Boolean(
        conversationUrl && targetConversationUrl === conversationUrl
      );
      await monitor.navigateToChatGPT(
        conversationUrl ?? "https://chatgpt.com",
        60_000,
        !alreadyOnConversation
      );
      const authentication = await monitor.authenticationStatus();
      if (!authentication.authenticated) {
        throw new Error(
          `${authentication.detail} Log in through \`oracle browser setup\` before consulting.`
        );
      }
      if (conversationUrl) {
        const actualUrl = await monitor.currentConversationUrl();
        if (actualUrl !== conversationUrl) {
          throw new Error(
            "The saved ChatGPT conversation is unavailable or redirected. Start a fresh conversation."
          );
        }
      }

      const configuredTimeoutMs = this.config.timeoutMs ?? 180000;
      // A tool may need far longer than the ordinary turn budget; take the
      // larger of the two rather than letting the default cut research short.
      const timeoutMs = request.tool
        ? Math.max(configuredTimeoutMs, COMPOSER_TOOL_MIN_TIMEOUT_MS[request.tool])
        : configuredTimeoutMs;
      let memoryInputTokens = 0;
      let memoryOutputTokens = 0;
      let memoryVerification: AccountMemoryVerification = "not-attempted";
      if (request.accountMemory) {
        const memoryPrompt = buildAccountMemoryPrompt(request.accountMemory);
        await monitor.navigateToChatGPT("https://chatgpt.com", 60_000);
        const memoryBaseline = await monitor.fillPromptAndSend(memoryPrompt);
        const memoryResponse = await monitor.waitForResponse(memoryBaseline, timeoutMs);
        memoryInputTokens = estimateTokens(memoryPrompt);
        memoryOutputTokens = estimateTokens(memoryResponse);
        if (!isAccountMemorySaveConfirmed(memoryResponse)) {
          throw new OracleError(
            "ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED",
            `ChatGPT did not confirm the Saved Memory update: ${memoryResponse.slice(0, 300)}`,
            "Enable Memory in ChatGPT Settings > Personalization, then retry the explicit memory request."
          );
        }

        // The confirmation above is the model's own claim, and it has been
        // observed to arrive for entries the account never stored — ChatGPT
        // decides for itself what is worth remembering. Check the account before
        // reporting success, and treat an unreachable check as unverified rather
        // than as either outcome.
        const check = await verifyAccountMemoryWrite(session, request.accountMemory);
        if (check.verified) {
          memoryVerification = "verified";
        } else if (check.conclusive) {
          throw new OracleError(
            "ORACLE_ACCOUNT_MEMORY_NOT_CONFIRMED",
            "ChatGPT reported the memory as saved, but the account does not contain it.",
            "ChatGPT stores only what it judges worth remembering; rephrase it as a durable fact or preference, or manage it under Settings > Personalization > Manage memories."
          );
        } else {
          memoryVerification = "unverified";
          console.warn(
            `[account-memory] ChatGPT reported the save but the account could not be checked (${check.reason}). Reporting it as unverified.`
          );
        }
        await monitor.navigateToChatGPT(conversationUrl ?? "https://chatgpt.com", 60_000);
        if (conversationUrl) {
          const actualUrl = await monitor.currentConversationUrl();
          if (actualUrl !== conversationUrl) {
            throw new Error(
              "The saved ChatGPT conversation became unavailable after the account-memory update."
            );
          }
        }
      }

      if (request.model && request.model !== "gpt-5.4") {
        const selected = await monitor.selectModel(request.model);
        if (!selected) {
          throw new OracleError(
            "ORACLE_BROWSER_EXECUTION_FAILED",
            `ChatGPT's UI model picker did not accept requested model "${request.model}".`,
            "Select an available model in ChatGPT and retry."
          );
        }
      }

      if (request.tool) {
        // Engaging the tool must be confirmed, not assumed: answering a question
        // that was meant to search the web without having searched looks like a
        // normal answer and is silently wrong.
        const label = COMPOSER_TOOL_LABELS[request.tool];
        const engaged = await monitor.selectComposerTool(label);
        if (!engaged) {
          throw new OracleError(
            "ORACLE_BROWSER_EXECUTION_FAILED",
            `Could not turn on "${label}" in the ChatGPT composer.`,
            "ChatGPT's composer menu may have changed, or the tool may be unavailable on this account. Retry without the tool option to answer without it."
          );
        }
      }

      if (uploadImages.length > 0) {
        await monitor.uploadImages(uploadImages, 60_000);
      }

      const browserUserPrompt = stripInlineImageDataUrls(request.userPrompt);
      const fullPrompt = request.systemPrompt && !conversationUrl
        ? `[SYSTEM]\n${request.systemPrompt}\n\n[USER]\n${browserUserPrompt}`
        : browserUserPrompt;

      const streamReader = this.config.streamEnabled === false
        ? undefined
        : new ChatGptStreamReader(session);
      await streamReader?.start();
      const baseline = await monitor.fillPromptAndSend(fullPrompt);
      const domResponse = monitor.waitForResponse(baseline, timeoutMs, {
        // Deep research and image generation sit unchanged for minutes at a
        // time; the stall reload that rescues a wedged UI would throw the work
        // away instead.
        allowStallReload: !request.tool || !COMPOSER_TOOLS_WITHOUT_STALL_RELOAD.has(request.tool)
      });
      // Whichever tier loses the race is abandoned mid-flight: the DOM poller keeps
      // evaluating against a session this method closes in `finally`, and the stream
      // reader outlives a DOM win the same way. Both rejections must be absorbed or
      // Node tears the process down on the unhandled rejection.
      domResponse.catch(() => undefined);
      const streamResponse = streamReader?.read();
      streamResponse?.catch(() => undefined);
      let text: string;
      let streamUsage: { promptTokens: number; completionTokens: number } | undefined;
      if (streamResponse) {
        try {
          const streamed = await Promise.race([
            streamResponse.then((result) => ({ tier: "stream" as const, ...result })),
            domResponse.then((domText) => ({ tier: "dom" as const, text: domText, usage: undefined }))
          ]);
          text = streamed.text;
          streamUsage = streamed.usage;
          if (streamed.tier === "dom") streamReader?.cancel();
          logTier(streamed.tier);
        } catch (streamError) {
          streamReader?.cancel();
          text = await domResponse;
          // Naming the failure is the whole point of the log: a silent fallback
          // reads as "the stream tier works" right up until someone deletes the
          // DOM path.
          logTier("dom", `stream failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`);
        }
      } else {
        text = await domResponse;
        logTier("dom", "stream disabled");
      }
      const responseId = await monitor.currentConversationUrl();
      const captured = await monitor.captureAssistantImages();
      const images = captured.images.length > 0
        ? await persistBrowserImages(
            request.artifactsDir ?? "",
            captured.images
          )
        : [];

      const inputTokens = streamUsage?.promptTokens ?? estimateTokens(fullPrompt);
      const outputTokens = streamUsage?.completionTokens ?? estimateTokens(text);

      return {
        responseId,
        text,
        // Only a checked write counts as saved; an unverifiable one is reported
        // through accountMemoryVerification instead of being claimed as success.
        accountMemorySaved: request.accountMemory
          ? memoryVerification === "verified"
          : undefined,
        accountMemoryVerification: request.accountMemory ? memoryVerification : undefined,
        images: images.length > 0 ? images : undefined,
        artifactWarnings: captured.warnings.length > 0 ? captured.warnings : undefined,
        usage: {
          inputTokens: inputTokens + memoryInputTokens,
          outputTokens: outputTokens + memoryOutputTokens,
          totalTokens: inputTokens + outputTokens + memoryInputTokens + memoryOutputTokens
        }
      };
    } catch (err) {
      let screenshotPath: string | undefined;
      if (session) {
        try {
          const diagDir = path.join(this.config.profileDir, "..", "diagnostics");
          screenshotPath = await this.diagnostics.captureDiagnosticScreenshot(session, diagDir);
        } catch {
          // ignore screenshot failure
        }
      }
      if (err instanceof OracleError) {
        if (err.code === "ORACLE_BROWSER_CHALLENGE_REQUIRED" && screenshotPath) {
          throw new OracleError(
            err.code,
            `${err.message} Diagnostic screenshot: ${screenshotPath}`,
            err.suggestion,
            { ...(err.details ?? {}), screenshotPath }
          );
        }
        throw err;
      }
      throw new OracleError(
        "ORACLE_BROWSER_EXECUTION_FAILED",
        `ChatGPT Browser consult failed: ${err instanceof Error ? err.message : String(err)}`,
        "Check browser diagnostics or log into ChatGPT via `oracle browser setup`.",
        classifyBrowserError(err) === "transient" ? { transient: true } : undefined
      );
    } finally {
      if (session) {
        session.close();
      }
    }
  }
}

export function classifyBrowserError(error: unknown): "transient" | "permanent" {
  if (error instanceof OracleError) {
    if (
      error.code === "ORACLE_BROWSER_RATE_LIMITED"
      || error.code === "ORACLE_BROWSER_CHALLENGE_REQUIRED"
      || error.code === "ORACLE_BROWSER_UNSUPPORTED_PLATFORM"
      || error.code === "ORACLE_BROWSER_MODE_DISABLED"
    ) return "permanent";
    if (error.code === "ORACLE_BROWSER_EXECUTION_FAILED") {
      return error.details?.transient === true ? "transient" : "permanent";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const permanent = /not authenticated|no chatgpt account session|unsupported platform|chrome.*(?:not found|unavailable)|browser mode.*disabled|response.* timed out|stream timed out/i;
  const transient = /websocket.*(?:disconnect|close|not open)|connection.*(?:closed|reset)|execution context was destroyed|cannot find context|promise was collected|navigation|target.*crash|target.*closed|cdp command .* timed out/i;
  return permanent.test(message) ? "permanent" : transient.test(message) ? "transient" : "permanent";
}

/**
 * Which tier answered is the signal for whether the stream path is reliable enough to
 * promote, so it is recorded on every consult. stderr keeps it clear of the answer the
 * CLI writes to stdout.
 */
function logTier(tier: "stream" | "dom", reason?: string): void {
  console.error(`[chatgpt-browser] answer tier: ${tier}${reason ? ` (${reason})` : ""}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
