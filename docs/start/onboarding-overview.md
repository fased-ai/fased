---
summary: "Overview of Fased onboarding options and flows"
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: "Onboarding Overview"
sidebarTitle: "Onboarding Overview"
---

# Onboarding Overview

Onboarding is the step that turns a raw install into a usable Fased runtime.

It handles:

- workspace initialization
- gateway mode and service install
- local signer wallet setup when selected
- optional singleton Mining wallet setup
- Hosting profile Tailscale and host hardening
- the base config the rest of the product depends on

<Info>
Before choosing Local or Hosting, read the
[First-run Setup Matrix](/start/setup-matrix). The wrong setup profile can
either skip VPS hardening or apply server-style SSH/firewall changes to a
personal machine.
</Info>

## The Two Real Entry Paths

### 1. CLI wizard

Use the CLI wizard if you want the full product path:

- local workstation setup
- VPS or hosted runtime setup
- wallet-aware operator path later
- Fased Network and SAT participation later

Run:

```bash
fased onboard
```

Docs:

- [Onboarding Wizard (CLI)](/start/wizard)
- [First-run Setup Matrix](/start/setup-matrix)
- [`fased onboard` command](/cli/onboard)
- [CLI Onboarding Reference](/start/wizard-cli-reference)

### 2. macOS app onboarding

Use the macOS app if you want the most guided Apple-first first-run flow.

Docs:

- [Onboarding (macOS App)](/start/onboarding)

## How To Choose The Right Onboarding Shape

### Local runtime

Use this when:

- the agent runs on your own laptop or desktop
- you want the browser dashboard first
- you do not need public hosted reachability on day one

This is the fastest path to a working self-hosted Agent.

<Warning>
If this machine is actually a VPS, Local mode does not apply the hosting
security baseline. Choose Hosting when the Gateway should run as an always-on
server.
</Warning>

### Hosted or VPS runtime

Use this when:

- the runtime will live on a VPS
- you want durable remote operation
- you expect to use Fased Network, hosted reachability, wallets, or SAT mining more seriously

This is the path that matters for operator use, not just chat convenience.

<Warning>
Hosting is for server-style machines. On a personal Linux workstation it can
change SSH and firewall behavior.
</Warning>

### Remote client mode

Use this when:

- the gateway already runs somewhere else
- this machine should act as a client/control point only

Remote mode configures access to an existing gateway.
It does not install or modify the remote host.

Remote only connects to an existing gateway. Use Local or Hosting on the host
machine first if the Gateway does not already exist.

## What Onboarding Should Produce

After onboarding, you should have:

- a working runtime identity
- a persisted config
- a running gateway or a valid remote-gateway connection
- a clear next step toward Agent setup, Wallet, Mining, Fased Network, Usage,
  Notifications, or Advanced diagnostics in the Control UI

The Control UI should continue setup from `/agents`, which acts as the single
Agent Setup checklist. Dashboard is for launch/status, not for duplicating every
setup control.

For the full browser setup map, read
[Control UI Setup Model](/start/control-ui-setup).

## What Moves To Control UI

Normal product setup happens after the Gateway is online:

- `/agents`: create or select the Agent workspace.
- `Agent > Models`: add model auth/sign-in and choose primary, fallback, and task models.
- `Agent > Skills`: create, review, install, configure, edit, and allow skills for that Agent.
- `Agent > Channels`: connect Telegram, Discord, WhatsApp, Slack, Signal, and other apps.
- `Agent > Services`: connect Gmail, Calendar, GitHub, web/search, browser/media, and APIs.
- `Agent > Memory`: enable session-memory and inspect this Agent's archive/QMD state.
- `Agent > Tasks`: schedule recurring work for this Agent and its sessions.
- `/memory`: read-only cross-Agent diagnostics.

CLI/provider flags still exist for automation, but first-run interactive
onboarding is no longer the place to configure every provider, skill, hook, or
channel.

## What To Read Next

- [Getting Started](/start/getting-started)
- [First-run Setup Matrix](/start/setup-matrix)
- [Fased Agent Setup](/start/fased)
- [Gateway](/gateway/index)
