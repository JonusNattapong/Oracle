import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
const packageJson = JSON.parse(
  await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")
);
const expectedVersion = packageJson.version;
if (typeof expectedVersion !== "string" || !expectedVersion) {
  throw new Error("package.json is missing a version.");
}
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-runtime-smoke-"));

function run(args, allowFailure = false) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ORACLE_HOME_DIR: temporaryRoot,
      ORACLE_WORKSPACE_ROOT: temporaryRoot,
      NODE_NO_WARNINGS: "1"
    },
    encoding: "utf8",
    timeout: 15_000
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `oracle ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`
    );
  }
  return `${result.stdout}${result.stderr}`;
}

try {
  const started = run(["daemon", "start", "--port", "0"]);
  if (!started.includes("Oracle Runtime started")) throw new Error(started);

  const status = run(["daemon", "status", "--json"]);
  const parsedStatus = JSON.parse(status);
  if (!parsedStatus.running || parsedStatus.health?.storage !== "sqlite") {
    throw new Error(`Unexpected daemon status: ${status}`);
  }
  if (parsedStatus.health?.version !== expectedVersion) {
    throw new Error(`Unexpected Runtime version: ${status}`);
  }
  if (JSON.stringify(parsedStatus).includes("token")) {
    throw new Error("Daemon status leaked the API token.");
  }

  const companionPresence = JSON.parse(run([
    "companion", "presence", "focus",
    "--source", "manual",
    "--ttl", "30",
    "--json"
  ]));
  if (
    companionPresence.presence?.state !== "focus"
    || companionPresence.intent?.action !== "silence"
  ) {
    throw new Error(
      `Unexpected Companion decision: ${JSON.stringify(companionPresence)}`
    );
  }
  const channels = JSON.parse(run(["companion", "channels", "--json"]));
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error(`Companion channels missing: ${JSON.stringify(channels)}`);
  }

  // Focus presence is a do-not-disturb boundary, so nothing may be delivered.
  const notified = JSON.parse(run(["companion", "notify-test", "--json"]));
  if (notified.intent?.action !== "silence" || notified.deliveries?.length !== 0) {
    throw new Error(
      `Companion delivered during focus presence: ${JSON.stringify(notified)}`
    );
  }
  const deliveries = JSON.parse(run(["companion", "deliveries", "--json"]));
  if (deliveries.length !== 0) {
    throw new Error(`Unexpected delivery records: ${JSON.stringify(deliveries)}`);
  }

  run(["companion", "pause", "--minutes", "5"]);
  const companionStatus = JSON.parse(run(["companion", "status", "--json"]));
  if (
    companionStatus.settings?.pause?.paused !== true
    || companionStatus.presence?.state !== "focus"
  ) {
    throw new Error(
      `Unexpected Companion status: ${JSON.stringify(companionStatus)}`
    );
  }
  run(["companion", "resume"]);
  const forgotten = run(["companion", "forget"]);
  if (!forgotten.includes("Forgot 1 semantic presence record")) {
    throw new Error(`Companion forget failed:\n${forgotten}`);
  }

  const issued = run([
    "team", "token",
    "--project", "runtime-smoke",
    "--agent", "smoke-agent",
    "--role", "lead"
  ]);
  const swarmToken = issued.match(/oracle_swarm_[A-Za-z0-9_-]+/)?.[0];
  if (!swarmToken) throw new Error(`Could not parse Remote Swarm token:\n${issued}`);
  const runtimeUrl = `http://${parsedStatus.state.host}:${parsedStatus.state.port}`;
  const connected = run([
    "connect", runtimeUrl,
    "--project", "runtime-smoke",
    "--agent", "smoke-agent",
    "--token", swarmToken
  ]);
  if (!connected.includes('Remote Swarm "runtime-smoke"')) {
    throw new Error(`Remote Swarm connect failed:\n${connected}`);
  }
  const teamStatus = run(["team", "status"]);
  if (!teamStatus.includes("smoke-agent") || !teamStatus.includes("runtime-smoke")) {
    throw new Error(`Unexpected Remote Swarm status:\n${teamStatus}`);
  }

  const snapshot = JSON.parse(run(["control", "snapshot"]));
  if (snapshot.version !== expectedVersion || snapshot.approvals?.pending !== 0) {
    throw new Error(`Unexpected Control Center snapshot: ${JSON.stringify(snapshot)}`);
  }
  const requested = run([
    "approval", "request",
    "--title", "Runtime smoke approval",
    "--requested-by", "worker",
    "--assigned-to", "lead",
    "--risk", "high"
  ]);
  const approvalId = requested.match(/approval-[0-9]{17}-[a-f0-9]{8}/)?.[0];
  if (!approvalId) throw new Error(`Could not parse approval id:\n${requested}`);
  if (!run(["approval", "list"]).includes(approvalId)) {
    throw new Error("Approval did not persist in the Runtime inbox.");
  }
  const approved = run(["approval", "approve", approvalId, "--by", "lead"]);
  if (!approved.includes("approved")) {
    throw new Error(`Approval decision failed:\n${approved}`);
  }
  const audit = run(["audit", "verify", "--cwd", temporaryRoot, "--json"]);
  if (JSON.parse(audit).valid !== true) {
    throw new Error(`Audit chain verification failed:\n${audit}`);
  }

  const created = run([
    "schedule", "add",
    "runtime smoke",
    "*/5 * * * *",
    "node -e \"process.stdout.write('runtime-smoke-ok')\""
  ]);
  const taskId = created.match(/[0-9]{17}-[a-f0-9]{8}/)?.[0];
  if (!taskId) throw new Error(`Could not parse scheduler task id:\n${created}`);

  const output = run(["schedule", "run", taskId]);
  if (!output.includes("runtime-smoke-ok")) throw new Error(output);

  const databasePath = path.join(temporaryRoot, "runtime", "oracle.db");
  await fs.stat(databasePath);
} finally {
  run(["daemon", "stop"], true);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Runtime smoke tests passed.");
