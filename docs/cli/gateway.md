---
summary: "Run, probe, and manage the self-hosted Fased gateway runtime."
read_when:
  - Running the gateway from the CLI
  - Debugging auth, bind modes, or connectivity
  - Managing gateway services or discovery
title: "gateway"
---

# `fased gateway`

The gateway is the live runtime server for channels, nodes, sessions, hooks, and
RPC control.

Related:

- [Gateway configuration](/gateway/configuration)
- [Gateway discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)

## Run

```bash
fased gateway
fased gateway run
```

Common run options:

- `--port <port>`
- `--bind <loopback|lan|tailnet|auto|custom>`
- `--auth <none|token|password|trusted-proxy>`
- `--token <token>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--force`
- `--dev`
- `--reset`
- `--verbose`
- `--ws-log <auto|full|compact>`
- `--raw-stream`
- `--raw-stream-path <path>`

Binding beyond loopback without token/password auth or trusted-proxy auth is blocked.

## Status and health

```bash
fased gateway health --url ws://127.0.0.1:18789
fased gateway status
fased gateway status --json
fased gateway probe
fased gateway probe --json
```

Shared RPC flags where supported:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--timeout <ms>`
- `--expect-final`
- `--json`

If you set `--url`, the CLI does not fall back to config or environment
credentials. Pass `--token` or `--password` explicitly for that target.

## Remote probe

```bash
fased gateway probe --ssh user@gateway-host
fased gateway probe --ssh user@gateway-host --ssh-identity ~/.ssh/id_ed25519
```

## RPC helper

```bash
fased gateway call status
fased gateway call logs.tail --params '{"sinceMs":60000}'
```

Use `gateway call` for low-level diagnostics and scripted checks.

## Usage summary

```bash
fased gateway usage-cost
fased gateway usage-cost --days 7
fased gateway usage-cost --json
```

For the browser view, use **Usage**.

## Admin helpers

Mutating admin helpers require `--yes`:

```bash
fased gateway admin inject-chat --session-key agent:main:main --message "noted" --yes
fased gateway admin push-test --node-id <node-id> --yes
fased gateway admin web-login-start --yes
fased gateway admin web-login-wait --yes
```

Use these for repair and diagnostics, not normal setup.

## Service management

```bash
fased gateway install
fased gateway start
fased gateway stop
fased gateway restart
fased gateway uninstall
```

The older `fased daemon ...` namespace remains as a compatibility command for
existing scripts.

## Discovery

```bash
fased gateway discover
fased gateway discover --json
```

Discovery can use mDNS on `local.` or Wide-Area Bonjour when you configure DNS.
