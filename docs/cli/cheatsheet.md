---
summary: "Fast CLI commands for opening the dashboard, starting the gateway, checking health, repairing config, and operating wallets/mining."
read_when:
  - You want the common Fased commands without reading every CLI page
  - You are running from a source checkout and need the node fased.mjs form
  - You need quick repair or diagnostic commands
title: "CLI Cheatsheet"
---

# CLI Cheatsheet

Use this page when you know what you want to do and need the command quickly.
The full reference pages explain options and edge cases.

## Installed CLI vs source checkout

Most docs use the installed command:

```bash
fased <command>
```

Normal users get that command by running `./install.sh` from the repo checkout.
The source checkout form below is for contributor/debug workflows.

When you are inside a source checkout and have already built the repo, use:

```bash
node fased.mjs <command>
```

Build first if `dist/entry.js` is missing:

```bash
pnpm install
pnpm build
```

## Open the Control UI

Open the dashboard:

```bash
fased dashboard
```

Print the auth-ready URL without opening a browser:

```bash
fased dashboard --no-open
```

Source checkout:

```bash
node fased.mjs dashboard --no-open
```

Print only the raw Gateway token:

```bash
fased config get gateway.auth.token
```

## Start the Gateway

Foreground local gateway:

```bash
fased gateway run --port 18789 --bind loopback
```

Foreground local gateway from a source checkout:

```bash
node fased.mjs gateway run --port 18789 --bind loopback
```

Force-replace a stuck local listener:

```bash
fased gateway run --port 18789 --bind loopback --force
```

Use the service path when Fased is installed as a daemon:

```bash
fased gateway status
fased gateway restart
```

## Health and repair

Fast health check:

```bash
fased gateway status
```

Connection probe:

```bash
fased gateway probe
```

General repair:

```bash
fased doctor
fased doctor --fix
```

Generate a missing Gateway token:

```bash
fased doctor --generate-gateway-token
```

Tail logs:

```bash
fased logs --limit 100
fased logs --follow
```

## Config quick reads

```bash
fased config get gateway.port
fased config get gateway.bind
fased config get gateway.auth.mode
fased config get gateway.auth.token
```

Use `fased config set ...` for small config changes. Prefer the Control UI for
normal setup because it validates related fields together.

## Profiles

Use an isolated dev profile:

```bash
fased --dev gateway run
fased --dev dashboard --no-open
```

Use a named profile:

```bash
fased --profile screenshot gateway run --port 19001
fased --profile screenshot dashboard --no-open
```

Profiles keep config and state separate under `~/.fased-<name>`.

## Channels

List configured channels:

```bash
fased channels list
```

Probe channel status:

```bash
fased channels status --probe
```

Link a supported channel account:

```bash
fased channels login --channel whatsapp
```

Resolve IDs for allowlists or routing:

```bash
fased channels resolve
```

## Wallets and SAT mining

Wallet status:

```bash
fased wallet status
```

Mining readiness:

```bash
fased mining readiness
```

Mining status:

```bash
fased mining status
```

List mining-eligible wallets:

```bash
fased mining wallets
```

Set a mining commit:

```bash
fased mining set-commit --sol 0.75
```

Start or stop mining:

```bash
fased mining start
fased mining stop
```

## Script-friendly output

Use JSON when another tool reads the result:

```bash
fased gateway status --json
fased channels status --json
fased mining status --json
```

Use plain output for terminals or copied logs:

```bash
fased logs --plain --limit 100
```

## Read next

- [Dashboard](/cli/dashboard)
- [Gateway](/cli/gateway)
- [Doctor](/cli/doctor)
- [Channels](/cli/channels)
- [Wallet](/cli/wallet)
- [Mining](/cli/mining)
