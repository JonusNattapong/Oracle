import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { OracleError } from "../errors.js";
import { createBridgeConnection, parseBridgeConnection } from "./connection.js";
import {
  DEFAULT_BRIDGE_LOCAL_PORT,
  bridgeRemoteHostUrl,
  buildSshTunnelCommand,
  formatSshTunnelCommand,
  runSshTunnel
} from "./tunnel.js";

const connection = createBridgeConnection({
  host: "127.0.0.1",
  port: 9473,
  token: "secret-token",
  ssh: { target: "ada@build-box" }
});

describe("ssh tunnel", () => {
  test("forwards the local port to the service address on the host", () => {
    const invocation = buildSshTunnelCommand(connection, { localPort: 9500 });
    expect(invocation.command).toBe("ssh");
    expect(invocation.args).toEqual([
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "9500:127.0.0.1:9473",
      "ada@build-box"
    ]);
  });

  test("includes the ssh port and identity file when the artifact has them", () => {
    const withIdentity = createBridgeConnection({
      host: "127.0.0.1",
      port: 9473,
      ssh: { target: "ada@build-box", port: 2222, identityFile: "/home/ada/.ssh/id_ed25519" }
    });
    expect(buildSshTunnelCommand(withIdentity).args).toEqual([
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${DEFAULT_BRIDGE_LOCAL_PORT}:127.0.0.1:9473`,
      "-p",
      "2222",
      "-i",
      "/home/ada/.ssh/id_ed25519",
      "ada@build-box"
    ]);
  });

  test("never puts the service token on the ssh command line", () => {
    const rendered = formatSshTunnelCommand(buildSshTunnelCommand(connection));
    expect(rendered).not.toContain("secret-token");
    expect(rendered).toBe(
      `ssh -N -o ExitOnForwardFailure=yes -L ${DEFAULT_BRIDGE_LOCAL_PORT}:127.0.0.1:9473 ada@build-box`
    );
  });

  test("refuses to build a tunnel without an ssh target", () => {
    const direct = createBridgeConnection({ host: "127.0.0.1", port: 9473 });
    expect(() => buildSshTunnelCommand(direct)).toThrow(/no ssh target/);
  });

  test("rejects out-of-range local ports", () => {
    for (const port of [0, -1, 70_000, 1.5]) {
      expect(() => buildSshTunnelCommand(connection, { localPort: port })).toThrow(OracleError);
    }
  });

  test("bridgeRemoteHostUrl points at the forwarded local port", () => {
    expect(bridgeRemoteHostUrl(9500)).toBe("http://127.0.0.1:9500");
    expect(bridgeRemoteHostUrl()).toBe(`http://127.0.0.1:${DEFAULT_BRIDGE_LOCAL_PORT}`);
  });

  test("a stale artifact still parses so doctor can explain it", () => {
    expect(
      parseBridgeConnection({
        version: 1,
        createdAt: "2020-01-01T00:00:00.000Z",
        host: "127.0.0.1",
        port: 9473
      }).port
    ).toBe(9473);
  });
});

describe("runSshTunnel", () => {
  function fakeChild(): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    (child as { killed: boolean }).killed = false;
    child.kill = vi.fn(() => true) as ChildProcess["kill"];
    return child;
  }

  test("runs in the foreground and returns the exit code", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const result = runSshTunnel(buildSshTunnelCommand(connection), spawnProcess);
    child.emit("close", 0, null);

    await expect(result).resolves.toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-N"]),
      expect.objectContaining({ stdio: "inherit" })
    );
  });

  test("reports 130 when the tunnel is interrupted", async () => {
    const child = fakeChild();
    const result = runSshTunnel(buildSshTunnelCommand(connection), vi.fn(() => child));
    child.emit("close", null, "SIGINT");
    await expect(result).resolves.toBe(130);
  });

  test("surfaces a missing ssh binary as a rejection", async () => {
    const child = fakeChild();
    const result = runSshTunnel(buildSshTunnelCommand(connection), vi.fn(() => child));
    child.emit("error", new Error("spawn ssh ENOENT"));
    await expect(result).rejects.toThrow(/ENOENT/);
  });
});
