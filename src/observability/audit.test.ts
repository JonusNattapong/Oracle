import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditLogger } from "./audit.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-audit-chain-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("AuditLogger hash chain", () => {
  test("detects content tampering", async () => {
    const logger = new AuditLogger();
    await logger.log(root, { action: "read", target: "one.txt", agentId: "agent" });
    await logger.log(root, { action: "write", target: "two.txt", agentId: "agent" });
    expect(await logger.verify(root)).toMatchObject({
      valid: true,
      verifiedEntries: 2,
      legacyEntries: 0
    });

    const file = path.join(root, ".oracle", "audit.jsonl");
    const content = await fs.readFile(file, "utf8");
    await fs.writeFile(file, content.replace("one.txt", "changed.txt"), "utf8");
    expect(await logger.verify(root)).toMatchObject({
      valid: false,
      brokenAt: 1,
      reason: "Entry hash does not match its content."
    });
  });

  test("detects tail truncation against the persisted head anchor", async () => {
    const logger = new AuditLogger();
    await logger.log(root, { action: "read", target: "one.txt" });
    await logger.log(root, { action: "read", target: "two.txt" });
    const file = path.join(root, ".oracle", "audit.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    await fs.writeFile(file, `${lines[0]}\n`, "utf8");
    expect(await logger.verify(root)).toMatchObject({
      valid: false,
      reason: "Audit log does not match its persisted head anchor."
    });
  });

  test("serializes concurrent writers and reports legacy unsigned entries", async () => {
    const logger = new AuditLogger();
    const dir = path.join(root, ".oracle");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "audit.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), action: "read", target: "legacy" })}\n`,
      "utf8"
    );
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        logger.log(root, { action: "tool", target: `tool-${index}` })
      )
    );
    expect(await logger.verify(root)).toMatchObject({
      valid: true,
      verifiedEntries: 10,
      legacyEntries: 1
    });
  });
});
