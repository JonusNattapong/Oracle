import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  detectImageMime,
  persistBrowserImages,
  validateBrowserImage
} from "./imageArtifacts.js";

const temporaryDirectories: string[] = [];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("Browser image artifacts", () => {
  test("detects magic bytes and rejects MIME spoofing", () => {
    expect(detectImageMime(png)).toBe("image/png");
    expect(() => validateBrowserImage({
      base64: png.toString("base64"),
      mimeType: "image/jpeg",
      fileName: "../../spoof.jpg"
    })).toThrow(/does not match/i);
  });

  test("sanitizes upload names and persists output under the session artifact root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-image-artifact-"));
    temporaryDirectories.push(root);

    const validated = validateBrowserImage({
      base64: png.toString("base64"),
      mimeType: "image/png",
      fileName: "../../diagram final.png"
    });
    expect(validated.fileName).toBe("diagram-final.png");

    const artifacts = await persistBrowserImages(path.join(root, "artifacts"), [{
      base64: png.toString("base64"),
      mimeType: "image/png",
      fileName: "../../ignored.png",
      alt: "Architecture diagram"
    }]);

    expect(artifacts[0]).toMatchObject({
      mimeType: "image/png",
      fileName: "output-001.png",
      sizeBytes: png.length,
      alt: "Architecture diagram"
    });
    expect(path.relative(path.join(root, "artifacts"), artifacts[0].path)).not.toMatch(/^\.\./);
    await expect(fs.readFile(artifacts[0].path)).resolves.toEqual(png);
  });

  test("requires an absolute session artifact directory", async () => {
    await expect(persistBrowserImages("relative/artifacts", [])).rejects.toMatchObject({
      code: "ORACLE_INVALID_REQUEST"
    });
  });
});
