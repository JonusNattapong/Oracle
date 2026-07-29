import fs from "node:fs/promises";
import path from "node:path";
import { OracleError } from "../../errors.js";
import type { ImageArtifact, SupportedImageMimeType } from "../../types.js";
import type { BrowserImagePayload } from "./types.js";

export const SUPPORTED_BROWSER_IMAGE_MIMES = new Set<SupportedImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp"
]);
export const MAX_BROWSER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_BROWSER_OUTPUT_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_BROWSER_OUTPUT_IMAGES = 8;

const EXTENSIONS: Record<SupportedImageMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp"
};

function decodeBase64(value: string): Buffer {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new OracleError(
      "ORACLE_INVALID_REQUEST",
      "Image data is not valid base64.",
      "Pass a PNG, JPEG, or WebP file through the files input."
    );
  }
  return Buffer.from(value, "base64");
}

export function detectImageMime(data: Buffer): SupportedImageMimeType | undefined {
  if (
    data.length >= 8
    && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function validateBrowserImage(input: BrowserImagePayload): {
  data: Buffer;
  mimeType: SupportedImageMimeType;
  fileName: string;
} {
  if (!SUPPORTED_BROWSER_IMAGE_MIMES.has(input.mimeType as SupportedImageMimeType)) {
    throw new OracleError(
      "ORACLE_INVALID_REQUEST",
      `Unsupported Browser Mode image MIME type: ${input.mimeType}`,
      "Use PNG, JPEG, or WebP images."
    );
  }
  const data = decodeBase64(input.base64);
  if (data.length > MAX_BROWSER_IMAGE_BYTES) {
    throw new OracleError(
      "ORACLE_INPUT_TOO_LARGE",
      `Browser Mode images are limited to ${MAX_BROWSER_IMAGE_BYTES} bytes each.`,
      "Resize or compress the image and try again."
    );
  }
  const detected = detectImageMime(data);
  if (!detected || detected !== input.mimeType) {
    throw new OracleError(
      "ORACLE_INVALID_REQUEST",
      "Image content does not match its declared MIME type.",
      "Use an unmodified PNG, JPEG, or WebP file with the correct extension."
    );
  }
  const base = path.basename(input.fileName || `image${EXTENSIONS[detected]}`)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  const stem = path.basename(base, path.extname(base)) || "image";
  return {
    data,
    mimeType: detected,
    fileName: `${stem}${EXTENSIONS[detected]}`
  };
}

export async function persistBrowserImages(
  artifactsDir: string,
  payloads: BrowserImagePayload[]
): Promise<ImageArtifact[]> {
  if (!path.isAbsolute(artifactsDir)) {
    throw new OracleError(
      "ORACLE_INVALID_REQUEST",
      "Browser artifact directory must be absolute.",
      "Run the consult through Oracle's session service."
    );
  }
  if (payloads.length > MAX_BROWSER_OUTPUT_IMAGES) {
    throw new OracleError(
      "ORACLE_INPUT_TOO_LARGE",
      `A Browser Mode response may return at most ${MAX_BROWSER_OUTPUT_IMAGES} images.`,
      "Ask ChatGPT to generate fewer images."
    );
  }

  const root = path.resolve(artifactsDir);
  const outputDir = path.resolve(root, "images");
  const relative = path.relative(root, outputDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OracleError(
      "ORACLE_INVALID_REQUEST",
      "Resolved image artifact path escaped the session directory.",
      "Inspect the Oracle session configuration."
    );
  }

  const validated = payloads.map(validateBrowserImage);
  const totalBytes = validated.reduce((sum, image) => sum + image.data.length, 0);
  if (totalBytes > MAX_BROWSER_OUTPUT_IMAGE_BYTES) {
    throw new OracleError(
      "ORACLE_INPUT_TOO_LARGE",
      `Generated images exceed the ${MAX_BROWSER_OUTPUT_IMAGE_BYTES}-byte response limit.`,
      "Ask ChatGPT for fewer or smaller images."
    );
  }

  await fs.mkdir(outputDir, { recursive: true });
  const artifacts: ImageArtifact[] = [];
  for (const [index, image] of validated.entries()) {
    const fileName = `output-${String(index + 1).padStart(3, "0")}${EXTENSIONS[image.mimeType]}`;
    const filePath = path.resolve(outputDir, fileName);
    const fileRelative = path.relative(outputDir, filePath);
    if (fileRelative.startsWith("..") || path.isAbsolute(fileRelative)) {
      throw new OracleError(
        "ORACLE_INVALID_REQUEST",
        "Resolved output image path escaped the artifact directory.",
        "Inspect the Oracle session configuration."
      );
    }
    await fs.writeFile(filePath, image.data, { flag: "wx" });
    artifacts.push({
      path: filePath,
      mimeType: image.mimeType,
      sizeBytes: image.data.length,
      fileName,
      alt: payloads[index].alt?.trim().slice(0, 300) || undefined
    });
  }
  return artifacts;
}
