import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-cli-smoke-"));
const homeDir = path.join(temporaryRoot, "home");
const workspaceRoot = path.join(temporaryRoot, "workspace");
await fs.mkdir(workspaceRoot, { recursive: true });

function execute(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ORACLE_HOME_DIR: homeDir },
    encoding: "utf8"
  });
}

function run(args) {
  const result = execute(args);
  if (result.status !== 0) {
    throw new Error(
      `oracle ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`
    );
  }
  return `${result.stdout}${result.stderr}`;
}

try {
  const created = run([
    "swarm", "create", "CLI smoke",
    "--architect", "architect-1",
    "--coder", "coder-1",
    "--reviewer", "reviewer-1",
    "--qa", "qa-1"
  ]);
  const workflowId = created.match(/swarm_[a-z0-9_]+/i)?.[0];
  if (!workflowId) throw new Error(`Could not parse workflow id:\n${created}`);
  const taskId = created.match(/task:\s+([a-z0-9-]+)/i)?.[1];
  if (!taskId) throw new Error(`Could not parse linked task id:\n${created}`);

  const proposalOutput = run([
    "swarm", "propose", workflowId, "coder-1", "Ship the stabilization change"
  ]);
  const proposalId = proposalOutput.match(/prop_[a-z0-9_]+/i)?.[0];
  if (!proposalId) throw new Error(`Could not parse proposal id:\n${proposalOutput}`);

  run(["swarm", "vote", proposalId, "reviewer-1", "approve", "review passed"]);
  const secondVote = run(["swarm", "vote", proposalId, "qa-1", "approve", "tests passed"]);
  if (!secondVote.includes("APPROVED")) {
    throw new Error(`Consensus votes did not persist:\n${secondVote}`);
  }

  const status = run(["swarm", "status"]);
  if (!status.includes(workflowId) || !status.includes("approved")) {
    throw new Error(`Swarm state did not persist across CLI processes:\n${status}`);
  }

  const recovery = run(["swarm", "recover"]);
  if (!recovery.includes("messages:  0 delivered")) {
    throw new Error(`Settled workflow recovery was not idempotent:\n${recovery}`);
  }

  const database = new DatabaseSync(path.join(homeDir, "runtime", "oracle.db"));
  const workflowRow = database.prepare(
    "SELECT record_json FROM coordination_workflows WHERE id = ?"
  ).get(workflowId);
  const taskRow = database.prepare(
    "SELECT record_json FROM coordination_tasks WHERE id = ?"
  ).get(taskId);
  database.close();
  if (!workflowRow || !taskRow) {
    throw new Error("SQLite coordination records were not persisted.");
  }
  const workflow = JSON.parse(workflowRow.record_json);
  const task = JSON.parse(taskRow.record_json);
  if (workflow.primaryTaskId !== taskId || task.workflowId !== workflowId) {
    throw new Error("Swarm workflow and task were not linked.");
  }
  if (!task.messageIds?.length || workflow.messageIds?.[0] !== task.messageIds[0]) {
    throw new Error("Task and workflow did not retain their linked messages.");
  }

  const oracleDir = path.join(workspaceRoot, ".oracle");
  await fs.mkdir(oracleDir, { recursive: true });
  await fs.writeFile(
    path.join(oracleDir, "audit.jsonl"),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      action: "write",
      target: "src/example.ts",
      agentId: "smoke"
    })}\n`,
    "utf8"
  );
  const audit = run(["audit", "show", "--cwd", workspaceRoot]);
  if (!audit.includes("src/example.ts")) {
    throw new Error(`Audit CLI did not read its persisted log:\n${audit}`);
  }

  const unsupportedAgent = execute([
    "agent",
    "do not run",
    "--backend",
    "chatgpt-browser",
    "--cwd",
    workspaceRoot
  ]);
  const unsupportedOutput = `${unsupportedAgent.stdout}${unsupportedAgent.stderr}`;
  if (
    unsupportedAgent.status === 0
    || !unsupportedOutput.includes("does not support agent tool use")
  ) {
    throw new Error(`Browser backend was not rejected before agent startup:\n${unsupportedOutput}`);
  }

  const bridgeRoot = path.join(temporaryRoot, "bridge");
  await fs.mkdir(bridgeRoot, { recursive: true });
  const bridgePreview = run([
    "bridge", "host",
    "--cwd", bridgeRoot,
    "--ssh-target", "smoke@bridge-host",
    "--token", "smoke-bridge-token",
    "--print-command"
  ]);
  if (bridgePreview.includes("smoke-bridge-token")) {
    throw new Error(`Bridge host preview leaked its token:\n${bridgePreview}`);
  }
  if (!bridgePreview.includes("<redacted>")) {
    throw new Error(`Bridge host preview did not redact its token:\n${bridgePreview}`);
  }
  const bridgeConnectionPath = path.join(bridgeRoot, ".oracle", "bridge.json");
  if (await fs.access(bridgeConnectionPath).then(() => true, () => false)) {
    throw new Error("Bridge host --print-command wrote an artifact instead of only previewing.");
  }

  await fs.mkdir(path.dirname(bridgeConnectionPath), { recursive: true });
  await fs.writeFile(
    bridgeConnectionPath,
    `${JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      host: "127.0.0.1",
      port: 9473,
      token: "smoke-bridge-token",
      ssh: { target: "smoke@bridge-host" }
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  const tunnelCommand = run([
    "bridge", "client", "--cwd", bridgeRoot, "--local-port", "9500", "--print-command"
  ]);
  if (
    !tunnelCommand.includes(
      "ssh -N -o ExitOnForwardFailure=yes -L 9500:127.0.0.1:9473 smoke@bridge-host"
    )
  ) {
    throw new Error(`Unexpected bridge tunnel command:\n${tunnelCommand}`);
  }
  if (tunnelCommand.includes("smoke-bridge-token")) {
    throw new Error(`Bridge tunnel command leaked the service token:\n${tunnelCommand}`);
  }

  const bridgeDoctor = execute(["bridge", "doctor", "--cwd", bridgeRoot, "--local-port", "9500"]);
  const bridgeDoctorOutput = `${bridgeDoctor.stdout}${bridgeDoctor.stderr}`;
  if (!bridgeDoctorOutput.includes("OK  connection artifact")) {
    throw new Error(`Bridge doctor did not read its artifact:\n${bridgeDoctorOutput}`);
  }
  if (bridgeDoctorOutput.includes("smoke-bridge-token")) {
    throw new Error(`Bridge doctor leaked the service token:\n${bridgeDoctorOutput}`);
  }
  if (bridgeDoctor.status === 0) {
    throw new Error(`Bridge doctor passed without a running tunnel:\n${bridgeDoctorOutput}`);
  }

  const badTarget = execute([
    "bridge", "host", "--cwd", bridgeRoot, "--ssh-target", "-oProxyCommand=touch /tmp/pwned",
    "--print-command"
  ]);
  if (badTarget.status === 0) {
    throw new Error("Bridge host accepted an ssh target that could inject an ssh option.");
  }

  console.log("CLI smoke tests passed.");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
