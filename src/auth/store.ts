import fs from "node:fs/promises";
import path from "node:path";

export interface TokenEntry {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  planTier?: string;
  /**
   * The OAuth client id this session was issued to. Persisted so a later
   * refresh works without the user having to re-supply ANTHROPIC_CLIENT_ID in
   * every shell that runs a consult.
   */
  clientId?: string;
}

export class TokenStore {
  constructor(private readonly rootDir: string) {}

  private filePath(provider: string): string {
    return path.join(this.rootDir, "auth", `${provider}.json`);
  }

  async read(provider: string): Promise<TokenEntry | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(provider), "utf8")) as TokenEntry;
    } catch {
      return null;
    }
  }

  async write(provider: string, entry: TokenEntry): Promise<void> {
    const filePath = this.filePath(provider);
    // These are long-lived credentials. Create the directory and the file
    // owner-only, and set the mode on the temp file *before* the rename so the
    // token is never briefly readable by other users on a shared machine.
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    // Atomic write via temp file + rename — concurrent CLI invocations (e.g. two
    // commands racing a token refresh) must never observe a partially-written
    // or truncated token file.
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), { encoding: "utf8", mode: 0o600 });
    // writeFile's mode applies only when creating; chmod covers a reused temp
    // path, and is a no-op on platforms without POSIX permissions.
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, filePath);
  }

  async delete(provider: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(provider));
    } catch {
      // ignore
    }
  }
}
