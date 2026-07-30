# Execution sandbox

Oracle's workspace policy prevents known unsafe paths and commands. The optional
Docker sandbox adds an operating-system boundary around commands issued by the
agent and by Runtime schedules.

## Enable it

Install and start Docker Desktop (or a compatible Docker daemon), then add the
following to `.oracle/policy.json`:

```json
{
  "sandbox": {
    "mode": "docker",
    "image": "node:24-bookworm-slim",
    "network": "none",
    "memoryMb": 2048,
    "cpuCount": 2,
    "pidsLimit": 256,
    "environment": ["NODE_OPTIONS"]
  }
}
```

Verify the effective boundary before enabling unattended work:

```bash
oracle sandbox doctor
```

`mode: "none"` is the default policy-only mode. `mode: "docker"` never falls
back to host execution: Docker startup, image, or container failures stop the
command and are recorded as failures.

## What Docker mode enforces

- Only the active workspace is mounted at `/workspace`.
- The container root filesystem is read-only; `/tmp` is an isolated tmpfs.
- Network is disabled by default.
- Capabilities are dropped and `no-new-privileges` is enabled.
- CPU, memory, process-count, and command-time limits are applied.
- Environment variables are excluded unless explicitly allow-listed.
- Each result is persisted in Runtime SQLite `sandbox_runs` and referenced by
  the normal agent audit trail.

The workspace mount is read-write so that coding tasks can change files. Treat
Docker isolation as a defence-in-depth control, not as permission to bypass
Oracle policy or approval gates.

## Limits

- The first image pull needs network access on the Docker host; the resulting
  agent command still runs with container networking disabled.
- A Docker daemon is privileged infrastructure. Use current Docker Desktop and
  do not use `--privileged`, host networking, or host PID mounts.
- Namespace mode and remote execution are intentionally outside this MVP.
