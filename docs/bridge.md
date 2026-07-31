# Bridge

`oracle bridge` shares one signed-in browser between machines. The machine with
Chrome and a logged-in ChatGPT session runs the **host**; any other machine runs
the **client**, reaching the host through an SSH tunnel.

This is the higher-level wrapper around `oracle serve` and `--remote-host`. It
adds the piece those two lack: a **connection artifact** that carries the
address and token from one machine to the other, so the client does not have to
be configured by hand.

## The connection artifact

`oracle bridge host` writes `.oracle/bridge.json`:

```json
{
  "version": 1,
  "createdAt": "2026-07-31T04:28:01.919Z",
  "host": "127.0.0.1",
  "port": 9473,
  "token": "<64 hex characters>",
  "ssh": { "target": "ada@build-box" }
}
```

The file is written owner-only (`0600`) because it contains the service token.
Copy it to the client over a channel you trust — `scp`, a password manager, an
already-authenticated session. Anyone holding it can drive the host's browser.

`host` and `ssh.target` are validated on both write and read. Values that could
be parsed as an ssh option — anything starting with `-` — are rejected, so a
hand-edited or untrusted artifact cannot turn into `ssh -oProxyCommand=…`.

## Host

Run this where Chrome is signed in:

```bash
oracle bridge host --ssh-target ada@build-box
```

It generates a token, writes the artifact, and starts the browser service in the
foreground. Ctrl+C stops it.

| Option | Meaning |
| --- | --- |
| `--host <address>` | Interface to bind (default `127.0.0.1`) |
| `--port <number>` | TCP port (default `9473`) |
| `--token <value>` | Fixed token; generated when omitted |
| `--ssh-target <user@host>` | How clients reach this machine |
| `--ssh-port <number>` | ssh port, when not 22 |
| `--identity-file <path>` | ssh key clients should use |
| `--out <path>` | Artifact location (default `.oracle/bridge.json`) |
| `--print-command` | Show the artifact and the redacted upstream command, start nothing |

Binding to `127.0.0.1` and reaching it over ssh is the intended setup: the
service is never exposed to the network directly, and the tunnel provides both
the encryption and the authentication.

`--print-command` never writes the artifact and never prints the token — it
shows `<redacted>` in both the artifact preview and the command line.

## Client

Copy the artifact to `.oracle/bridge.json` on the client, then:

```bash
oracle bridge client
```

This opens `ssh -N -L 9473:127.0.0.1:9473 ada@build-box` and holds it open. In
another shell:

```bash
export ORACLE_REMOTE_HOST=http://127.0.0.1:9473
export ORACLE_REMOTE_TOKEN=<token from .oracle/bridge.json>
oracle ask "review this" --backend browser
```

| Option | Meaning |
| --- | --- |
| `--connection <path>` | Artifact to read |
| `--local-port <number>` | Local port to forward (default `9473`) |
| `--no-tunnel` | Print direct connection details, open no tunnel |
| `--print-command` | Print the ssh command without running it |

Use `--local-port` when `9473` is taken locally — for example when this machine
is also running its own `oracle serve`.

The token never appears on the ssh command line. It travels in the artifact and
reaches Oracle through `ORACLE_REMOTE_TOKEN`.

## Doctor

```bash
oracle bridge doctor
```

```
OK    connection artifact: /work/.oracle/bridge.json → 127.0.0.1:9473
OK    freshness: created 12m old
OK    token: present (set ORACLE_REMOTE_TOKEN from the artifact)
OK    ssh target: ada@build-box
OK    ssh client: found on PATH
FAIL  tunnel: 127.0.0.1:9473 refused a connection; start it with `oracle bridge client`
```

It exits non-zero if any check fails. The checks run in order and stop early
when a later one cannot mean anything — an unreadable artifact reports one
failure rather than five.

`--direct` probes the service address from the artifact instead of the tunnel,
for setups where the host is reachable without ssh. `--local-port` must match
whatever the client forwards.

An artifact older than 24 hours is reported as stale; a `createdAt` in the
future is reported as clock skew between the two machines rather than as
freshness.

## Relationship to `serve`

`oracle serve` is still there and unchanged. `bridge host` wraps it: same
service, same flags for the browser profile, plus the artifact. Use `serve`
when you configure the client by hand, `bridge host` when you want the client to
configure itself.
