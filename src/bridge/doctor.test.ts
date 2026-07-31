import { describe, expect, test, vi } from "vitest";
import { OracleError } from "../errors.js";
import { createBridgeConnection, type BridgeConnection } from "./connection.js";
import { runBridgeDoctor, type BridgeDoctorProbes } from "./doctor.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function connection(overrides: Partial<Parameters<typeof createBridgeConnection>[0]> = {}) {
  return createBridgeConnection({
    host: "127.0.0.1",
    port: 9473,
    token: "secret-token",
    ssh: { target: "ada@build-box" },
    now: NOW,
    ...overrides
  });
}

function probes(
  connectionValue: BridgeConnection | Error,
  overrides: Partial<BridgeDoctorProbes> = {}
): Partial<BridgeDoctorProbes> {
  return {
    readConnection: vi.fn(async () => {
      if (connectionValue instanceof Error) throw connectionValue;
      return connectionValue;
    }),
    hasSsh: vi.fn(async () => true),
    probeTcp: vi.fn(async () => true),
    now: () => NOW,
    ...overrides
  };
}

function check(checks: Awaited<ReturnType<typeof runBridgeDoctor>>, name: string) {
  const found = checks.find((entry) => entry.name === name);
  expect(found, `expected a "${name}" check`).toBeDefined();
  return found!;
}

describe("bridge doctor", () => {
  test("reports every check as passing for a healthy tunnel", async () => {
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json" },
      probes(connection())
    );
    expect(checks.every((entry) => entry.ok)).toBe(true);
    expect(checks.map((entry) => entry.name)).toEqual([
      "connection artifact",
      "freshness",
      "token",
      "ssh target",
      "ssh client",
      "tunnel"
    ]);
  });

  test("stops after the artifact check when it cannot be read", async () => {
    const missing = new OracleError(
      "ORACLE_BRIDGE_UNAVAILABLE",
      "No bridge connection artifact at /work/.oracle/bridge.json.",
      "Run `oracle bridge host`."
    );
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json" },
      probes(missing)
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].detail).toContain("oracle bridge host");
  });

  test("flags an artifact older than the maximum age", async () => {
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json" },
      probes(connection({ now: new Date("2026-07-20T12:00:00.000Z") }))
    );
    const freshness = check(checks, "freshness");
    expect(freshness.ok).toBe(false);
    expect(freshness.detail).toContain("oracle bridge host");
  });

  test("calls out clock skew when the artifact is stamped in the future", async () => {
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json" },
      probes(connection({ now: new Date("2026-08-01T12:00:00.000Z") }))
    );
    expect(check(checks, "freshness").detail).toContain("clock skew");
  });

  test("flags a missing token", async () => {
    const withoutToken = createBridgeConnection({
      host: "127.0.0.1",
      port: 9473,
      ssh: { target: "ada@build-box" },
      now: NOW
    });
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json" },
      probes(withoutToken)
    );
    expect(check(checks, "token").ok).toBe(false);
  });

  test("flags a missing ssh client and a tunnel that is not listening", async () => {
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json", localPort: 9500 },
      probes(connection(), {
        hasSsh: vi.fn(async () => false),
        probeTcp: vi.fn(async () => false)
      })
    );
    expect(check(checks, "ssh client").ok).toBe(false);
    const tunnel = check(checks, "tunnel");
    expect(tunnel.ok).toBe(false);
    expect(tunnel.detail).toContain("9500");
    expect(tunnel.detail).toContain("oracle bridge client");
  });

  test("probes the forwarded local port, not the host address", async () => {
    const probeTcp = vi.fn(async () => true);
    await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json", localPort: 9500 },
      probes(connection(), { probeTcp })
    );
    expect(probeTcp).toHaveBeenCalledWith("127.0.0.1", 9500, 3_000);
  });

  test("direct mode probes the service address and skips the ssh checks", async () => {
    const probeTcp = vi.fn(async () => true);
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json", direct: true },
      probes(connection({ host: "10.0.0.5", port: 9600 }), { probeTcp })
    );
    expect(probeTcp).toHaveBeenCalledWith("10.0.0.5", 9600, 3_000);
    expect(checks.map((entry) => entry.name)).not.toContain("ssh client");
    expect(check(checks, "service reachable").ok).toBe(true);
  });

  test("explains an artifact with no ssh target instead of throwing", async () => {
    const direct = createBridgeConnection({ host: "127.0.0.1", port: 9473, now: NOW });
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json" },
      probes(direct)
    );
    const target = check(checks, "ssh target");
    expect(target.ok).toBe(false);
    expect(target.detail).toContain("--ssh-target");
    expect(checks.map((entry) => entry.name)).not.toContain("tunnel");
  });

  test("never leaks the token into check output", async () => {
    const checks = await runBridgeDoctor(
      { connectionPath: "/work/.oracle/bridge.json" },
      probes(connection())
    );
    expect(JSON.stringify(checks)).not.toContain("secret-token");
  });
});
