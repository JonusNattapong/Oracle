import type { ContextFile } from "../types.js";
import { estimateTokens } from "../tokens.js";
import { resolveFiles } from "./files.js";
import { scanFilesForSecrets } from "./secrets.js";
import { buildUserPrompt, renderBundle, DEFAULT_SYSTEM_PROMPT } from "./bundle.js";
import { OracleError } from "../errors.js";

export interface CreateBundleOptions {
  prompt: string;
  files?: string[];
  include?: string[];
  exclude?: string[];
  cwd?: string;
  systemPrompt?: string;
  maxFileSizeBytes?: number;
  maxInputBytes?: number;
  allowEmptyFiles?: boolean;
}

export interface FileManifestEntry {
  path: string;
  sizeBytes: number;
  mimeType?: string;
  isImage: boolean;
  estimatedTokens: number;
}

export interface BundleResult {
  prompt: string;
  systemPrompt: string;
  userPrompt: string;
  bundle: string;
  files: ContextFile[];
  manifest: FileManifestEntry[];
  estimatedInputTokens: number;
  inputBytes: number;
  cwd: string;
}

export class BundleService {
  async createBundle(options: CreateBundleOptions): Promise<BundleResult> {
    const cwd = options.cwd ?? process.cwd();
    const patterns = [
      ...(options.files ?? []),
      ...(options.include ?? [])
    ];

    const files = await resolveFiles(patterns, {
      cwd,
      maxFileSizeBytes: options.maxFileSizeBytes ?? 1_000_000
    });

    if (files.length === 0 && !options.allowEmptyFiles && patterns.length > 0) {
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

    const inputBytes = Buffer.byteLength(options.prompt) + files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const maxInputBytes = options.maxInputBytes ?? 5_000_000;
    if (inputBytes > maxInputBytes) {
      throw new OracleError(
        "ORACLE_INPUT_TOO_LARGE",
        "The selected input exceeds the configured size limit.",
        "Select fewer or smaller files.",
        { inputBytes, maxInputBytes }
      );
    }

    const systemPrompt = options.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    const userPrompt = buildUserPrompt(options.prompt, files);
    const bundle = renderBundle({
      prompt: options.prompt,
      files,
      systemPrompt
    });

    const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);

    const manifest: FileManifestEntry[] = files.map((file) => ({
      path: file.path,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      isImage: Boolean(file.base64),
      estimatedTokens: estimateTokens(file.content)
    }));

    return {
      prompt: options.prompt,
      systemPrompt,
      userPrompt,
      bundle,
      files,
      manifest,
      estimatedInputTokens,
      inputBytes,
      cwd
    };
  }
}
