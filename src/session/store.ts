import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionRecord } from "../types.js";

export class FileSessionStore {
  constructor(
    private readonly homeDir =
      process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle")
  ) {}

  private sessionsDir(): string {
    return path.join(this.homeDir, "sessions");
  }

  private sessionDir(id: string): string {
    return path.join(this.sessionsDir(), id);
  }

  async create(input: {
    id: string;
    cwd: string;
    prompt: string;
    model: string;
    provider?: string;
    conversationId?: string;
    accountMemoryRequested?: boolean;
    preset?: string;
    files: string[];
    bundle: string;
  }): Promise<SessionRecord> {
    await fs.mkdir(this.sessionsDir(), { recursive: true });
    const dir = this.sessionDir(input.id);
    await fs.mkdir(dir, { recursive: false });
    const bundlePath = path.join(dir, "bundle.md");
    await fs.writeFile(bundlePath, input.bundle, "utf8");

    const record: SessionRecord = {
      sessionId: input.id,
      status: "error",
      model: input.model,
      provider: input.provider,
      conversationId: input.conversationId,
      accountMemoryRequested: input.accountMemoryRequested,
      preset: input.preset,
      files: input.files,
      output: "",
      usage: {},
      createdAt: new Date().toISOString(),
      cwd: input.cwd,
      prompt: input.prompt,
      bundlePath
    };
    await this.write(record);
    return record;
  }

  async write(record: SessionRecord): Promise<void> {
    const dir = this.sessionDir(record.sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "session.json"),
      JSON.stringify(record, null, 2),
      "utf8"
    );
    await fs.writeFile(path.join(dir, "output.md"), record.output, "utf8");
  }

  async read(id: string): Promise<SessionRecord | null> {
    try {
      const raw = await fs.readFile(
        path.join(this.sessionDir(id), "session.json"),
        "utf8"
      );
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  async list(limit = 20): Promise<SessionRecord[]> {
    await fs.mkdir(this.sessionsDir(), { recursive: true });
    const entries = await fs.readdir(this.sessionsDir(), { withFileTypes: true });
    const records = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.read(entry.name))
    );
    return records
      .filter((record): record is SessionRecord => record !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}
