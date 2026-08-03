import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ConsultRequest,
  ConsultResult,
  ContextFile,
  ImageArtifact,
  SessionRecord
} from "../types.js";
import { BundleService } from "../context/bundleService.js";
import type { Provider } from "../providers/provider.js";
import { FileSessionStore } from "../session/store.js";
import { OracleError } from "../errors.js";
import { scanFilesForSecrets } from "../context/secrets.js";

function createSessionId(prompt: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36) || "consult";
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

async function validateImageArtifacts(
  images: ImageArtifact[] | undefined,
  artifactsDir: string
): Promise<ImageArtifact[] | undefined> {
  if (!images?.length) return undefined;
  const root = await fs.realpath(artifactsDir);
  const validated: ImageArtifact[] = [];
  for (const image of images) {
    const realPath = await fs.realpath(image.path);
    const relative = path.relative(root, realPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new OracleError(
        "ORACLE_INVALID_REQUEST",
        "Backend image artifact escaped the session artifact directory.",
        "Inspect the selected execution backend before retrying."
      );
    }
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || stat.size !== image.sizeBytes) {
      throw new OracleError(
        "ORACLE_INVALID_REQUEST",
        "Backend image artifact metadata does not match the stored file.",
        "Inspect the selected execution backend before retrying."
      );
    }
    validated.push({ ...image, path: realPath });
  }
  return validated;
}

/**
 * Records a completed call's token usage. Kept as a narrow callback so
 * ConsultService does not have to own a database handle.
 */
export type CostSink = (entry: {
  provider: string;
  model: string;
  agent?: string;
  inputTokens: number;
  outputTokens: number;
}) => void;

export type BackendResolver = (id: string) => Provider;

export class ConsultService {
  constructor(
    private readonly provider: Provider,
    private readonly sessions = new FileSessionStore(),
    private readonly costSink?: CostSink,
    private readonly bundleService = new BundleService(),
    private readonly backendResolver?: BackendResolver
  ) {}

  async consult(request: ConsultRequest): Promise<ConsultResult> {
    const cwd = request.cwd ?? process.cwd();
    const model = request.model ?? "gpt-5.4";
    const requestedBackend = request.provider ?? this.provider.id;
    let activeProvider = this.provider;
    if (requestedBackend !== this.provider.id) {
      if (!this.backendResolver) {
        throw new OracleError(
          "ORACLE_PROVIDER_UNAVAILABLE",
          `Backend override '${requestedBackend}' is not available in this runtime.`,
          `Use the configured backend '${this.provider.id}' or start Oracle with a backend resolver.`
        );
      }
      activeProvider = this.backendResolver(requestedBackend);
    }

    const accountMemory = request.accountMemory?.trim();
    if (request.accountMemory !== undefined && !accountMemory) {
      throw new OracleError(
        "ORACLE_ACCOUNT_MEMORY_INVALID",
        "ChatGPT account memory text must not be empty.",
        "Pass a short, high-level fact or preference, or omit accountMemory."
      );
    }
    if (accountMemory && !activeProvider.capabilities.accountMemory) {
      throw new OracleError(
        "ORACLE_ACCOUNT_MEMORY_UNSUPPORTED",
        `Backend '${activeProvider.id}' cannot write account-level memory.`,
        "Use backend 'chatgpt-browser' with an authenticated ChatGPT account."
      );
    }
    if (accountMemory) {
      const secretFindings = scanFilesForSecrets([{
        path: "<account-memory>",
        content: accountMemory,
        sizeBytes: Buffer.byteLength(accountMemory)
      }]);
      if (secretFindings.length > 0) {
        throw new OracleError(
          "ORACLE_SECRET_DETECTED",
          "Potential secrets were detected in the requested ChatGPT account memory.",
          "Remove credentials or tokens. Account memory should contain only a high-level fact or preference.",
          { findings: secretFindings }
        );
      }
    }

    let previousResponseId = request.previousResponseId;
    if (
      !previousResponseId
      && request.conversationId
      && activeProvider.capabilities.continuation
    ) {
      const priorSessions = await this.sessions.list(500);
      previousResponseId = priorSessions.find(
        (session) =>
          session.status === "completed"
          && session.provider === activeProvider.id
          && session.conversationId === request.conversationId
          && Boolean(session.responseId)
      )?.responseId;
    }

    const bundleResult = await this.bundleService.createBundle({
      prompt: request.prompt,
      files: request.files,
      cwd,
      systemPrompt: request.systemPrompt,
      maxFileSizeBytes: request.maxFileSizeBytes,
      maxInputBytes: request.maxInputBytes,
      allowEmptyFiles: request.allowEmptyFiles
    });

    const { systemPrompt, userPrompt, bundle, files, estimatedInputTokens } = bundleResult;
    const id = createSessionId(request.title?.trim() || request.prompt);
    let record = await this.sessions.create({
      id,
      cwd,
      prompt: request.prompt,
      model,
      provider: activeProvider.id,
      conversationId: request.conversationId,
      accountMemoryRequested: Boolean(accountMemory),
      preset: request.preset,
      files: files.map((file) => file.path),
      bundle
    });
    record = { ...record, estimatedInputTokens };

    try {
      const artifactsDir = path.join(path.dirname(record.bundlePath), "artifacts");
      const response = await activeProvider.run({
        model,
        systemPrompt,
        userPrompt,
        cwd,
        previousResponseId,
        accountMemory,
        tool: request.tool,
        artifactsDir,
        images: files
          .filter((f): f is ContextFile & { base64: string; mimeType: string } => !!f.base64 && !!f.mimeType)
          .map((f) => ({
            base64: f.base64,
            mimeType: f.mimeType,
            fileName: path.basename(f.path)
          }))
      });
      const responseImages = await validateImageArtifacts(response.images, artifactsDir);
      record = {
        ...record,
        status: "completed",
        completedAt: new Date().toISOString(),
        responseId: response.responseId,
        accountMemorySaved: response.accountMemorySaved,
        accountMemoryVerification: response.accountMemoryVerification,
        images: responseImages,
        artifactWarnings: response.artifactWarnings,
        output: response.text,
        usage: response.usage,
        error: undefined
      };

      // Accounting is best-effort: a bookkeeping failure must not turn a
      // successful consult into an error.
      try {
        this.costSink?.({
          provider: activeProvider.id,
          model,
          agent: request.agent,
          inputTokens: response.usage.inputTokens ?? 0,
          outputTokens: response.usage.outputTokens ?? 0,
        });
      } catch { /* ignore */ }
    } catch (error) {
      record = {
        ...record,
        status: "error",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
    }

    await this.sessions.write(record);
    return record;
  }

  async session(id: string): Promise<SessionRecord | null> {
    return this.sessions.read(id);
  }

  async listSessions(limit?: number): Promise<SessionRecord[]> {
    return this.sessions.list(limit);
  }
}
