import crypto from "node:crypto";
import type { ConsultRequest, ConsultResult, ContextFile, SessionRecord } from "../types.js";
import { estimateTokens } from "../tokens.js";
import { resolveFiles } from "../context/files.js";
import { scanFilesForSecrets } from "../context/secrets.js";
import {
  buildUserPrompt,
  DEFAULT_SYSTEM_PROMPT,
  renderBundle
} from "../context/bundle.js";
import type { Provider } from "../providers/provider.js";
import { FileSessionStore } from "../session/store.js";
import { OracleError } from "../errors.js";

function createSessionId(prompt: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36) || "consult";
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
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

export class ConsultService {
  constructor(
    private readonly provider: Provider,
    private readonly sessions = new FileSessionStore(),
    private readonly costSink?: CostSink
  ) {}

  async consult(request: ConsultRequest): Promise<ConsultResult> {
    const cwd = request.cwd ?? process.cwd();
    const model = request.model ?? "gpt-5.4";
    const files = await resolveFiles(request.files ?? [], {
      cwd,
      maxFileSizeBytes: request.maxFileSizeBytes
    });
    // ponytail: allow prompt-only consults (e.g. context injected into the prompt)
    if (files.length === 0 && !request.allowEmptyFiles) {
      throw new OracleError(
        "ORACLE_NO_FILES",
        "No files matched the consultation request.",
        "Check the project include patterns or pass existing project files."
      );
    }

    const secretFindings = scanFilesForSecrets(files);
    if (secretFindings.length > 0) {
      throw new OracleError(
        "ORACLE_SECRET_DETECTED",
        "Potential secrets were detected in selected files.",
        "Remove the files from the selection or replace credentials with placeholders.",
        { findings: secretFindings }
      );
    }

    const inputBytes = Buffer.byteLength(request.prompt) + files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (inputBytes > (request.maxInputBytes ?? 5_000_000)) {
      throw new OracleError(
        "ORACLE_INPUT_TOO_LARGE",
        "The selected input exceeds the configured size limit.",
        "Select fewer or smaller files.",
        { inputBytes, maxInputBytes: request.maxInputBytes ?? 5_000_000 }
      );
    }

    const systemPrompt = request.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    const userPrompt = buildUserPrompt(request.prompt, files);
    const bundle = renderBundle({
      prompt: request.prompt,
      files,
      systemPrompt
    });

    const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
    const id = createSessionId(request.prompt);
    let record = await this.sessions.create({
      id,
      cwd,
      prompt: request.prompt,
      model,
      provider: request.provider ?? this.provider.id,
      preset: request.preset,
      files: files.map((file) => file.path),
      bundle
    });
    record = { ...record, estimatedInputTokens };

    try {
      const response = await this.provider.run({
        model,
        systemPrompt,
        userPrompt,
        cwd,
        previousResponseId: request.previousResponseId,
        images: files
          .filter((f): f is ContextFile & { base64: string; mimeType: string } => !!f.base64 && !!f.mimeType)
          .map((f) => ({ base64: f.base64, mimeType: f.mimeType }))
      });
      record = {
        ...record,
        status: "completed",
        completedAt: new Date().toISOString(),
        responseId: response.responseId,
        output: response.text,
        usage: response.usage,
        error: undefined
      };

      // Accounting is best-effort: a bookkeeping failure must not turn a
      // successful consult into an error.
      try {
        this.costSink?.({
          provider: request.provider ?? this.provider.id,
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
