import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultAgentTools } from "./tools.js";
import type { AgentContext, AgentTool } from "./types.js";
import { SandboxRunner } from "../sandbox/runner.js";

let root: string;
let ctx: AgentContext;
let tools: Map<string, AgentTool>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-agent-tools-"));
  ctx = {
    workspaceRoot: root,
    readOnly: false,
    sandbox: new SandboxRunner({
      workspaceRoot: root,
      policy: { mode: "none", image: "node:24-bookworm-slim", network: "none", memoryMb: 2048, cpuCount: 2, pidsLimit: 256, environment: [] }
    })
  };
  tools = new Map(defaultAgentTools().map((t) => [t.name, t]));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function tool(name: string): AgentTool {
  const t = tools.get(name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

describe("agent tools", () => {
  test("write_file then read_file round-trips content", async () => {
    await tool("write_file").execute({ path: "src/a.ts", content: "export const x = 1;" }, ctx);
    const read = await tool("read_file").execute({ path: "src/a.ts" }, ctx);
    expect(read).toBe("export const x = 1;");
  });

  test("write_file creates parent directories", async () => {
    await tool("write_file").execute({ path: "deep/nested/dir/file.txt", content: "hi" }, ctx);
    const onDisk = await fs.readFile(path.join(root, "deep/nested/dir/file.txt"), "utf8");
    expect(onDisk).toBe("hi");
  });

  test("edit_file replaces a unique string", async () => {
    await tool("write_file").execute({ path: "f.txt", content: "hello world" }, ctx);
    await tool("edit_file").execute({ path: "f.txt", old_string: "world", new_string: "oracle" }, ctx);
    const read = await tool("read_file").execute({ path: "f.txt" }, ctx);
    expect(read).toBe("hello oracle");
  });

  test("edit_file rejects a non-unique old_string", async () => {
    await tool("write_file").execute({ path: "f.txt", content: "a a a" }, ctx);
    await expect(
      tool("edit_file").execute({ path: "f.txt", old_string: "a", new_string: "b" }, ctx)
    ).rejects.toThrow(/appears 3 times/);
  });

  test("edit_file errors when old_string is absent", async () => {
    await tool("write_file").execute({ path: "f.txt", content: "abc" }, ctx);
    await expect(
      tool("edit_file").execute({ path: "f.txt", old_string: "zzz", new_string: "b" }, ctx)
    ).rejects.toThrow(/not found/);
  });

  test("path traversal outside the workspace is rejected", async () => {
    await expect(
      tool("read_file").execute({ path: "../escape.txt" }, ctx)
    ).rejects.toThrow(/escapes the workspace/);
    await expect(
      tool("write_file").execute({ path: "../../evil.txt", content: "x" }, ctx)
    ).rejects.toThrow(/escapes the workspace/);
  });

  test("grep finds matching lines with path and line number", async () => {
    await tool("write_file").execute({ path: "src/one.ts", content: "const foo = 1;\nconst bar = 2;" }, ctx);
    await tool("write_file").execute({ path: "src/two.ts", content: "const baz = 3;" }, ctx);
    const out = await tool("grep").execute({ query: "foo" }, ctx);
    const outStr = typeof out === "string" ? out : JSON.stringify(out);
    expect(outStr.replace(/\\/g, "/")).toContain("src/one.ts:1:");
    expect(outStr).not.toContain("two.ts");
  });

  test("glob matches by path substring", async () => {
    await tool("write_file").execute({ path: "src/a.test.ts", content: "x" }, ctx);
    await tool("write_file").execute({ path: "src/a.ts", content: "x" }, ctx);
    const out = await tool("glob").execute({ pattern: ".test.ts" }, ctx);
    const outStr = typeof out === "string" ? out : JSON.stringify(out);
    expect(outStr).toContain("a.test.ts");
    expect(outStr.split("\n")).not.toContain("src/a.ts");
  });

  test("list_dir lists entries with trailing slash for folders", async () => {
    await tool("write_file").execute({ path: "src/a.ts", content: "x" }, ctx);
    const out = await tool("list_dir").execute({ path: "." }, ctx);
    expect(out).toContain("src/");
  });

  test("bash tool is exposed and executes a command", async () => {
    const bash = tools.get("bash");
    expect(bash).toBeDefined();
    expect(bash!.mutating).toBe(true);
    const out = await bash!.execute({ command: "echo hello-oracle" }, ctx);
    expect(String(out).trim()).toBe("hello-oracle");
  }, 15000);

  test("read-only mode disables mutating tools", async () => {
    const ro: AgentContext = { workspaceRoot: root, readOnly: true };
    await expect(tool("write_file").execute({ path: "x.txt", content: "y" }, ro)).rejects.toThrow(/read-only/);
  });
});
