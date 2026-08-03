/**
 * Live end-to-end verification against the signed-in ChatGPT account.
 *
 * Unit tests pass on code that does not work. Every defect found while building
 * the browser backend shipped green: memory that never reached the prompt, a
 * mirror reported as saved that the account never took, a sidecar spawn that
 * could not succeed on this platform. What they had in common is that nothing
 * ever checked the observable result — the bundle actually sent, the account
 * actually read back.
 *
 * So these checks assert on state outside the process: the bundle file written
 * for the consult, the session record, the account's own memory listing. They
 * cost real time and a real ChatGPT session, which is why they are not part of
 * `npm test`.
 *
 *   npm run verify:live
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
const oracleHome = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");

let workspace;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  OK  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? workspace,
    encoding: "utf8",
    timeout: options.timeout ?? 15 * 60_000,
    env: { ...process.env }
  });
}

/** The newest session directory, which is the consult that just ran. */
async function newestSession() {
  const sessionsDir = path.join(oracleHome, "sessions");
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  const dirs = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const full = path.join(sessionsDir, entry.name);
      return { name: entry.name, full, mtime: (await fs.stat(full)).mtimeMs };
    })
  );
  dirs.sort((a, b) => b.mtime - a.mtime);
  return dirs[0];
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a check, allowing one retry.
 *
 * These drive a real browser back to back, and Chrome under that load produces
 * CDP timeouts that clear on their own — observed here, where two checks failed
 * in sequence and both passed immediately when run alone. A retry is honest for
 * UI automation, but it is reported, because a check that only passes the second
 * time is not the same as one that passes.
 */
async function check(name, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const detail = await fn();
      record(name, true, attempt === 1 ? detail : `${detail} (passed on retry)`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2) {
        record(name, false, message);
        return;
      }
      console.log(`  ..    ${name} — retrying after: ${message.slice(0, 100)}`);
      await settle(5_000);
    }
  }
}

async function main() {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-verify-live-"));
  await fs.mkdir(path.join(workspace, ".oracle"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, ".oracle", "config.json"),
    JSON.stringify({
      backend: "chatgpt-browser",
      experimental: { browserMode: true },
      memory: { store: "local" }
    }, null, 2),
    "utf8"
  );
  console.log(`workspace: ${workspace}\n`);

  await check("browser session is authenticated", async () => {
    const out = runCli(["browser", "status", "--live"], { timeout: 5 * 60_000 });
    const text = `${out.stdout}${out.stderr}`;
    if (!/\[OK\] chatgpt account session/.test(text)) {
      throw new Error(text.trim().split("\n").pop() ?? "no output");
    }
    return "signed in";
  });

  await settle(3_000);
  await check("DOM handles Browser Mode depends on still resolve", async () => {
    const out = runCli(["browser", "status", "--selectors"], { timeout: 5 * 60_000 });
    const text = `${out.stdout}${out.stderr}`;
    const failed = text.split("\n").filter((line) => /\[FAIL\]/.test(line));
    if (failed.length) throw new Error(failed.join("; ").trim());
    return `${text.split("\n").filter((l) => /selector |composer tool /.test(l)).length} handles checked`;
  });

  await settle(3_000);
  await check("a consult answers and writes a session record", async () => {
    const out = runCli(["ask", "--no-memory", "Reply with exactly: VERIFY_LIVE_OK"]);
    if (!/VERIFY_LIVE_OK/.test(out.stdout)) {
      throw new Error(`unexpected answer: ${(out.stdout || out.stderr).trim().slice(0, 200)}`);
    }
    const session = await newestSession();
    const record = JSON.parse(await fs.readFile(path.join(session.full, "session.json"), "utf8"));
    if (record.status !== "completed") throw new Error(`session status ${record.status}`);
    return session.name;
  });

  await check("the session id is named after the question, not the context", async () => {
    // Prepending recalled memory to the prompt once made every session share a
    // name, because the id is slugged from the prompt.
    const session = await newestSession();
    if (!session.name.startsWith("reply-with-exactly")) {
      throw new Error(`session named "${session.name}"`);
    }
    return session.name;
  });

  await check("recalled memory reaches the bundle that is sent", async () => {
    // The defect this covers: recall worked, the block was built, and it never
    // made it into the prompt — visible only in the bundle actually sent.
    const marker = `Verify-live probe ${Date.now()}: the deploy codeword is HALCYON.`;
    runCli(["memory", "list"]); // ensure the store exists
    const remembered = spawnSync(process.execPath, ["-e", `
      const { MemoryAdapter } = await import(${JSON.stringify(pathToUrl(path.join(repositoryRoot, "dist", "memory", "adapter.js")))});
      await new MemoryAdapter(${JSON.stringify(workspace)}).remember("verify", "fact", ${JSON.stringify(marker)}, { importance: 0.9 });
    `], { encoding: "utf8", cwd: workspace, env: { ...process.env } });
    if (remembered.status !== 0) throw new Error(`could not seed memory: ${remembered.stderr.trim()}`);

    const out = runCli(["ask", "What is the deploy codeword? Answer with the single word."]);
    const session = await newestSession();
    const bundle = await fs.readFile(path.join(session.full, "bundle.md"), "utf8");
    if (!bundle.includes("HALCYON")) {
      throw new Error("the recalled memory is absent from the bundle that was sent");
    }
    if (!/HALCYON/i.test(out.stdout)) {
      throw new Error(`memory was in the bundle but the answer ignored it: ${out.stdout.trim().slice(0, 120)}`);
    }
    return "present in the bundle and used in the answer";
  });

  await settle(3_000);
  await check("web search engages and is confirmed before sending", async () => {
    const out = runCli(["ask", "--web-search", "--no-memory", "Reply with exactly: WEB_OK"]);
    const text = `${out.stdout}${out.stderr}`;
    if (/Could not turn on/.test(text)) throw new Error("the composer tool could not be engaged");
    if (!/WEB_OK/.test(out.stdout)) {
      throw new Error(`unexpected answer: ${text.trim().slice(0, 160)}`);
    }
    return "pill confirmed, answer returned";
  });

  await settle(3_000);
  await check("the account's own memory listing is readable", async () => {
    // Account reads go through an internal endpoint. If it changes, `chatgpt`
    // and `hybrid` stores lose their only trustworthy read.
    const probe = spawnSync(process.execPath, ["-e", `
      const { createExecutionBackend } = await import(${JSON.stringify(pathToUrl(path.join(repositoryRoot, "dist", "providers", "factory.js")))});
      const backend = createExecutionBackend("chatgpt-browser", {
        homeDir: ${JSON.stringify(oracleHome)},
        experimentalBrowserMode: true,
        browser: { profileDir: ${JSON.stringify(path.join(oracleHome, "chrome-profile"))} }
      });
      const snapshot = await backend.listAccountMemories();
      console.log(JSON.stringify({ known: snapshot.known, reason: snapshot.reason ?? null, count: snapshot.entries?.length ?? 0 }));
    `], { encoding: "utf8", cwd: workspace, timeout: 5 * 60_000, env: { ...process.env } });
    const line = probe.stdout.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(line || "{}");
    if (!parsed.known) throw new Error(parsed.reason ?? probe.stderr.trim().slice(0, 160));
    return `${parsed.count} entries visible`;
  });

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.error(`Live verification failed: ${failed.map((f) => f.name).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  await fs.rm(workspace, { recursive: true, force: true });
}

function pathToUrl(filePath) {
  return new URL(`file://${filePath.replace(/\\/g, "/")}`).href;
}

main().catch((error) => {
  console.error(`Live verification crashed: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
