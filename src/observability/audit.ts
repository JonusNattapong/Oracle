import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../control/payload.js";

const GENESIS_HASH = "0".repeat(64);

export interface AuditRecord {
  timestamp: string;
  action: "read" | "write" | "edit" | "delete" | "bash" | "tool" | "policy_denied";
  target: string;
  agentId?: string;
  details?: Record<string, unknown>;
  sequence?: number;
  previousHash?: string;
  hash?: string;
}

export interface AuditVerification {
  valid: boolean;
  entries: number;
  verifiedEntries: number;
  legacyEntries: number;
  brokenAt?: number;
  reason?: string;
  headHash?: string;
}

export class AuditLogger {
  private auditFile(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".oracle", "audit.jsonl");
  }

  private lockFile(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".oracle", "audit.lock");
  }

  private headFile(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".oracle", "audit.head.json");
  }

  async log(workspaceRoot: string, record: Omit<AuditRecord, "timestamp">): Promise<void> {
    const targetDir = path.join(workspaceRoot, ".oracle");
    await fs.mkdir(targetDir, { recursive: true });
    await this.withLock(workspaceRoot, async () => {
      const records = await this.readRawRecords(workspaceRoot);
      const lastVerified = [...records]
        .reverse()
        .find((candidate) => candidate.record?.hash && candidate.record.sequence);
      const sequence = (lastVerified?.record?.sequence ?? 0) + 1;
      const previousHash = lastVerified?.record?.hash ?? GENESIS_HASH;
      const unsigned: AuditRecord = {
        timestamp: new Date().toISOString(),
        ...record,
        sequence,
        previousHash
      };
      const entry: AuditRecord = {
        ...unsigned,
        hash: this.hash(unsigned)
      };
      await fs.appendFile(this.auditFile(workspaceRoot), `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      const headPath = this.headFile(workspaceRoot);
      const temporaryHead = `${headPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(
        temporaryHead,
        JSON.stringify({ sequence, hash: entry.hash }),
        { encoding: "utf8", mode: 0o600 }
      );
      await fs.rename(temporaryHead, headPath);
    });
  }

  async readRecords(workspaceRoot: string, limit = 100): Promise<AuditRecord[]> {
    const records = await this.readRawRecords(workspaceRoot);
    return records
      .filter((entry): entry is { raw: string; record: AuditRecord } => Boolean(entry.record))
      .slice(-Math.max(1, limit))
      .map((entry) => entry.record)
      .reverse();
  }

  async verify(workspaceRoot: string): Promise<AuditVerification> {
    const entries = await this.readRawRecords(workspaceRoot);
    let previousHash = GENESIS_HASH;
    let expectedSequence = 1;
    let verifiedEntries = 0;
    let legacyEntries = 0;
    let chainStarted = false;

    for (let index = 0; index < entries.length; index++) {
      const { record } = entries[index];
      if (!record) {
        return {
          valid: false,
          entries: entries.length,
          verifiedEntries,
          legacyEntries,
          brokenAt: index + 1,
          reason: "Invalid JSON entry."
        };
      }
      if (!record.hash || !record.previousHash || !record.sequence) {
        if (chainStarted) {
          return {
            valid: false,
            entries: entries.length,
            verifiedEntries,
            legacyEntries,
            brokenAt: index + 1,
            reason: "Unsigned entry found after the hash chain started."
          };
        }
        legacyEntries++;
        continue;
      }
      chainStarted = true;
      const { hash, ...unsigned } = record;
      const calculated = this.hash(unsigned);
      if (
        record.sequence !== expectedSequence
        || record.previousHash !== previousHash
        || !constantTimeEqual(hash, calculated)
      ) {
        return {
          valid: false,
          entries: entries.length,
          verifiedEntries,
          legacyEntries,
          brokenAt: index + 1,
          reason: record.sequence !== expectedSequence
            ? `Expected sequence ${expectedSequence}, received ${record.sequence}.`
            : record.previousHash !== previousHash
              ? "Previous hash does not match."
              : "Entry hash does not match its content."
        };
      }
      previousHash = hash;
      expectedSequence++;
      verifiedEntries++;
    }

    const head = await this.readHead(workspaceRoot);
    if (head === "invalid") {
      return {
        valid: false,
        entries: entries.length,
        verifiedEntries,
        legacyEntries,
        brokenAt: entries.length + 1,
        reason: "Audit head anchor is invalid."
      };
    }
    if (
      head
      && (head.sequence !== verifiedEntries || head.hash !== (verifiedEntries ? previousHash : undefined))
    ) {
      return {
        valid: false,
        entries: entries.length,
        verifiedEntries,
        legacyEntries,
        brokenAt: entries.length + 1,
        reason: "Audit log does not match its persisted head anchor."
      };
    }
    return {
      valid: true,
      entries: entries.length,
      verifiedEntries,
      legacyEntries,
      headHash: verifiedEntries ? previousHash : undefined
    };
  }

  private hash(record: Omit<AuditRecord, "hash">): string {
    return crypto.createHash("sha256").update(canonicalJson(record)).digest("hex");
  }

  private async readHead(
    workspaceRoot: string
  ): Promise<{ sequence: number; hash: string } | "invalid" | null> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.headFile(workspaceRoot), "utf8")
      ) as { sequence?: unknown; hash?: unknown };
      if (
        !Number.isInteger(parsed.sequence)
        || Number(parsed.sequence) < 1
        || typeof parsed.hash !== "string"
        || !/^[a-f0-9]{64}$/.test(parsed.hash)
      ) return "invalid";
      return { sequence: Number(parsed.sequence), hash: parsed.hash };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return "invalid";
    }
  }

  private async readRawRecords(
    workspaceRoot: string
  ): Promise<Array<{ raw: string; record?: AuditRecord }>> {
    try {
      const content = await fs.readFile(this.auditFile(workspaceRoot), "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((raw) => {
          try {
            return { raw, record: JSON.parse(raw) as AuditRecord };
          } catch {
            return { raw };
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async withLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = this.lockFile(workspaceRoot);
    const deadline = Date.now() + 5_000;
    let handle: fs.FileHandle | undefined;
    while (!handle) {
      try {
        handle = await fs.open(lockPath, "wx", 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows may report EPERM instead of EEXIST for existing/stale locks
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) {
            await fs.unlink(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the audit log lock.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
