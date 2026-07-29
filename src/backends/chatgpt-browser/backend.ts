import path from "node:path";
import type {
  DoctorCheck,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  ExecutionBackendRequest,
  ExecutionBackendResponse
} from "../backend.js";
import type { ChatGptBrowserConfig } from "./types.js";
import { ChromeLauncher, findOrCreatePageTarget } from "./chrome.js";
import {
  CdpSession,
  normalizeChatGptConversationUrl,
  ResponseMonitor
} from "./response.js";
import { BrowserDiagnostics } from "./diagnostics.js";
import { OracleError } from "../../errors.js";
import { estimateTokens } from "../../tokens.js";
import {
  buildAccountMemoryPrompt,
  isAccountMemorySaveConfirmed
} from "./accountMemory.js";
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
    structuredUsage: false,
    supportedPlatforms: Object.freeze(["darwin" as NodeJS.Platform, "linux" as NodeJS.Platform, "win32" as NodeJS.Platform])
  });

  private diagnostics = new BrowserDiagnostics();

  constructor(private readonly config: ChatGptBrowserConfig) {}

  async healthCheck(): Promise<DoctorCheck[]> {
    return this.diagnostics.runDoctor(this.config);
  }

  async run(request: ExecutionBackendRequest): Promise<ExecutionBackendResponse> {
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

      const timeoutMs = this.config.timeoutMs ?? 180000;
      let memoryInputTokens = 0;
      let memoryOutputTokens = 0;
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

      if (uploadImages.length > 0) {
        await monitor.uploadImages(uploadImages, 60_000);
      }

      const browserUserPrompt = stripInlineImageDataUrls(request.userPrompt);
      const fullPrompt = request.systemPrompt && !conversationUrl
        ? `[SYSTEM]\n${request.systemPrompt}\n\n[USER]\n${browserUserPrompt}`
        : browserUserPrompt;

      const baseline = await monitor.fillPromptAndSend(fullPrompt);

      const text = await monitor.waitForResponse(baseline, timeoutMs);
      const responseId = await monitor.currentConversationUrl();
      const captured = await monitor.captureAssistantImages();
      const images = captured.images.length > 0
        ? await persistBrowserImages(
            request.artifactsDir ?? "",
            captured.images
          )
        : [];

      const inputTokens = estimateTokens(fullPrompt);
      const outputTokens = estimateTokens(text);

      return {
        responseId,
        text,
        accountMemorySaved: request.accountMemory ? true : undefined,
        images: images.length > 0 ? images : undefined,
        artifactWarnings: captured.warnings.length > 0 ? captured.warnings : undefined,
        usage: {
          inputTokens: inputTokens + memoryInputTokens,
          outputTokens: outputTokens + memoryOutputTokens,
          totalTokens: inputTokens + outputTokens + memoryInputTokens + memoryOutputTokens
        }
      };
    } catch (err) {
      if (session) {
        try {
          const diagDir = path.join(this.config.profileDir, "..", "diagnostics");
          await this.diagnostics.captureDiagnosticScreenshot(session, diagDir);
        } catch {
          // ignore screenshot failure
        }
      }
      if (err instanceof OracleError) {
        throw err;
      }
      throw new OracleError(
        "ORACLE_BROWSER_EXECUTION_FAILED",
        `ChatGPT Browser consult failed: ${err instanceof Error ? err.message : String(err)}`,
        "Check browser diagnostics or log into ChatGPT via `oracle browser setup`."
      );
    } finally {
      if (session) {
        session.close();
      }
    }
  }
}
