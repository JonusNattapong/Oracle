import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { OracleError } from "../errors.js";
import { PANEL_MANIFEST_VERSION, type PanelManifest } from "./types.js";

export function panelsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".oracle", "panels");
}

export function panelManifestPath(cwd: string, id: string): string {
  // Must begin with an alphanumeric: that rules out `..` and ids that would
  // land as hidden files, while leaving real `panel-<stamp>-<uuid>` ids valid.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new OracleError(
      "ORACLE_INVALID_REQUEST",
      `Invalid panel id '${id}'.`,
      "Use an id from `oracle panel list`."
    );
  }
  return path.join(panelsDir(cwd), `${id}.json`);
}

export class PanelStore {
  constructor(private readonly cwd: string) {}

  async write(manifest: PanelManifest): Promise<string> {
    const filePath = panelManifestPath(this.cwd, manifest.id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
    return filePath;
  }

  async read(id: string): Promise<PanelManifest> {
    const filePath = panelManifestPath(this.cwd, id);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OracleError(
          "ORACLE_SESSION_NOT_FOUND",
          `No panel manifest '${id}'.`,
          "Run `oracle panel list` to see recorded panels."
        );
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as PanelManifest;
    if (parsed.version !== PANEL_MANIFEST_VERSION) {
      throw new OracleError(
        "ORACLE_INVALID_REQUEST",
        `Panel manifest '${id}' has unsupported version ${parsed.version}.`,
        `This Oracle writes version ${PANEL_MANIFEST_VERSION} manifests.`
      );
    }
    return parsed;
  }

  /** Newest first. A manifest that fails to parse is skipped, not fatal. */
  async list(limit = 20): Promise<PanelManifest[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(panelsDir(this.cwd));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifests: PanelManifest[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(panelsDir(this.cwd), entry), "utf8");
        manifests.push(JSON.parse(raw) as PanelManifest);
      } catch {
        continue;
      }
    }
    manifests.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return manifests.slice(0, limit);
  }
}
