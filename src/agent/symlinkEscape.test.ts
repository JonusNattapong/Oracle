import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultAgentTools } from "./tools.js";
import type { AgentContext, AgentTool } from "./types.js";
import { SandboxRunner } from "../sandbox/runner.js";

/**
 * Workspace confinement has to survive a link, not just `../`.
 *
 * resolveInWorkspace() resolves lexically, which normalises traversal but says
 * nothing about what a link points at: a link created inside the workspace
 * resolves to a path inside the workspace, and the kernel then follows it out.
 * The consult path guards this with fs.realpath (src/context/files.ts); the
 * agent tools are the side that can also write.
 *
 * Link creation is permission-dependent, so each kind is probed separately and
 * skipped rather than silently passing when the OS refuses. Windows needs
 * elevation for file symlinks but allows directory junctions unprivileged.
 */
let root: string;
let outside: string;
let ctx: AgentContext;
let tools: Map<string, AgentTool>;
let hasFileLink = false;
let hasJunction = false;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-symlink-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "SUPER_SECRET_VALUE", "utf8");

  ctx = {
    workspaceRoot: root,
    readOnly: false,
    sandbox: new SandboxRunner({
      workspaceRoot: root,
      policy: { mode: "none", image: "node:24-bookworm-slim", network: "none", memoryMb: 2048, cpuCount: 2, pidsLimit: 256, environment: [] }
    })
  };
  tools = new Map(defaultAgentTools().map((t) => [t.name, t]));

  try {
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"), "file");
    hasFileLink = true;
  } catch { hasFileLink = false; }
  try {
    await fs.symlink(outside, path.join(root, "escape"), "junction");
    hasJunction = true;
  } catch { hasJunction = false; }
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tool(name: string): AgentTool {
  const t = tools.get(name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

describe("agent tools — link confinement", () => {
  test("read_file cannot follow a file symlink out of the workspace", async (context) => {
    if (!hasFileLink) return context.skip();
    await expect(tool("read_file").execute({ path: "link.txt" }, ctx))
      .rejects.toThrow(/escapes the workspace/i);
  });

  test("read_file cannot read through a directory link", async (context) => {
    if (!hasJunction) return context.skip();
    await expect(tool("read_file").execute({ path: "escape/secret.txt" }, ctx))
      .rejects.toThrow(/escapes the workspace/i);
  });

  test("write_file cannot write through a directory link", async (context) => {
    if (!hasJunction) return context.skip();
    await expect(tool("write_file").execute({ path: "escape/planted.txt", content: "x" }, ctx))
      .rejects.toThrow(/escapes the workspace/i);
    await expect(fs.readFile(path.join(outside, "planted.txt"), "utf8")).rejects.toThrow();
  });

  test("list_dir cannot enumerate through a directory link", async (context) => {
    if (!hasJunction) return context.skip();
    await expect(tool("list_dir").execute({ path: "escape" }, ctx))
      .rejects.toThrow(/escapes the workspace/i);
  });

  test("glob does not descend a directory link", async (context) => {
    if (!hasJunction) return context.skip();
    await tool("write_file").execute({ path: "inside.txt", content: "ok" }, ctx);
    const found = await tool("glob").execute({ pattern: ".txt" }, ctx);
    expect(found).toContain("inside.txt");
    expect(found).not.toContain("secret");
  });

  test("grep does not search through a directory link", async (context) => {
    if (!hasJunction) return context.skip();
    const hits = await tool("grep").execute({ query: "SUPER_SECRET_VALUE" }, ctx);
    expect(hits).not.toContain("SUPER_SECRET_VALUE");
  });

  test("ordinary paths inside the workspace still work", async () => {
    await tool("write_file").execute({ path: "src/ok.ts", content: "export const x = 1;" }, ctx);
    expect(await tool("read_file").execute({ path: "src/ok.ts" }, ctx)).toBe("export const x = 1;");
  });

  test("plain ../ traversal is still rejected", async () => {
    await expect(tool("read_file").execute({ path: "../outside/secret.txt" }, ctx))
      .rejects.toThrow(/escapes the workspace/i);
  });
});
