---
summary: "CLI onboarding wizard for host/security, workspace, gateway, wallet, and mining setup."
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Onboarding Wizard (CLI)

The onboarding wizard is the **recommended** way to set up Fased on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures the machine/runtime first: host profile, workspace, Gateway,
local signer wallet state, optional singleton Mining wallet setup, and hosting
security. Model providers, skills, extensions, channels, services, hooks,
memory activation, tasks, and Agent assembly continue in the Control UI.
Before choosing Local or Hosting, read the
[First-run Setup Matrix](/start/setup-matrix).

```bash
fased onboard
```

<Info>
Fastest first chat:

1. Run `./install.sh` locally.
2. Keep the dashboard tab that opens, or run `fased dashboard`.
3. Use **Agent > Models**, then open **Chat** and send a test message.

</Info>

<Tip>
VPS setup: create the server, join it to Tailscale, then run `./install.sh --hosting`.
Manual VPS setup does not require a Tailscale API key; use one only for
non-interactive automation. If you start as `root`, the installer bootstraps
Fased into `/home/app/fased`, continues as the `app` user, and removes the
temporary root checkout after successful hosted onboarding.
</Tip>

<Note>
Hosting is not a remote-control option for a laptop session. Run the hosted
installer on the VPS itself. If a normal `fased onboard` session cannot apply
host security, it stops with “Hosted setup unavailable” instead of changing only
part of the setup.
</Note>

To reconfigure later:

```bash
fased configure
fased agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive`.
</Note>

<Tip>
Recommended: set up a Brave Search API key so the agent can use `web_search`
(`web_fetch` works without a key). Easiest path: `Agent > Services`; CLI
automation can use `fased configure --section web`, which stores
`tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

The wizard starts with **QuickStart** (defaults) vs **Advanced** (full control).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Local gateway (loopback)
    - Workspace default (or existing workspace)
    - Gateway port **18789**
    - Gateway auth **Token** (auto‑generated, even on loopback)
    - DM isolation default: local onboarding writes
      `session.dmScope: "per-channel-peer"` when unset. Details:
      [CLI Onboarding Reference](/start/wizard-cli-reference#outputs-and-internals)
    - Tailscale exposure **Off**
    - Chat app channels are connected later from `Agent > Channels`
  </Tab>
  <Tab title="Advanced (full control)">
    - Exposes profile, mode, workspace, gateway, Fased Network,
      signer/wallet, daemon, health, and UI choices.
    - Product setup continues in the Control UI after the Gateway is online.
  </Tab>
</Tabs>

## What the wizard configures

**Local mode (default)** walks you through these steps in this order:

1. **QuickStart or Manual** — choose defaults or full control.
2. **Setup profile** — choose Local or Hosting. Local is for this machine and
   does not harden a VPS. Hosting is for a VPS or always-on server and requires
   Tailscale.
3. **Existing config** — update settings or repair auth/sessions if this
   machine was already configured.
4. **Workspace** — location for agent files (default `~/.fased/workspace`) and
   bootstrap files.
5. **Gateway** — how the Control UI, CLI, WebChat, and channels connect. Choose
   port, bind address, and auth mode. Local setup keeps Tailscale out of the
   basic path; Hosting requires Tailscale through host security.
6. **Fased Network** — optional federation/managed routing setup.
7. **Signer and Wallet** — policy-bound sends, receipts, mining, Marketplace,
   and reviewed wallet-connected workflows. Wallet setup is not required for
   normal chat.
8. **Workspace bootstrap** — writes config and creates workspace/session state.
9. **Hosting security** — applied only for the Hosting profile.
10. **Daemon, health, and Control UI** — service startup, health checks, and
    final dashboard/TUI choice.

For Hosting, the wizard checks Tailscale before it applies SSH/firewall
hardening. If Tailscale is missing, it tries to install it. If the host is not
logged in, it can use `--ts-authkey` for unattended setup or show a login URL
in SSH for normal manual setup. Open that URL in your local computer's browser,
then return to the SSH session. If Tailscale cannot provide a tailnet IP,
Hosting refuses to continue because the remote dashboard and admin path depend
on Tailscale.

Hosted setup uses two machines:

- **Your own computer:** opens the dashboard and runs SSH checks.
- **The VPS:** runs Fased Agent.

Use the terminal that has Tailscale access:

- **Windows:** use PowerShell or Windows Terminal. Install/sign into the
  Windows Tailscale app from [tailscale.com/download](https://tailscale.com/download).
  PowerShell can SSH into the Linux VPS.
- **macOS:** use Terminal and install/sign into the macOS Tailscale app.
- **Linux:** use Terminal and install/start Tailscale on that Linux machine.
- **WSL:** advanced only. Either use PowerShell instead, or install/start
  Tailscale inside WSL too. Windows Tailscale does not automatically make WSL a
  Tailscale node.

If you lose access to the Tailscale account used for a hosted VPS, normal
dashboard and SSH access can be lost. Recovery then depends on the VPS
provider's web console/rescue mode/rebuild tools.

Before lock-down, the wizard asks you to test `tailscale ping
YOUR_VPS_TAILSCALE_NAME`, then `ssh app@YOUR_VPS_TAILSCALE_NAME` from your own
computer. That computer must have Tailscale installed, running, and signed into
the same tailnet as the VPS. Do not run the check commands inside the VPS SSH
session. If your own computer says `tailscale: command not found`, install
Tailscale on your own computer first:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

On Windows or macOS, install and sign into the Tailscale app, then use
PowerShell or Terminal for the check. A separate VPN on your own computer can
interfere with Tailscale DNS or routing; if ping/SSH cannot reach the VPS,
disconnect the other VPN or allow Tailscale traffic and try again.

If `tailscale ping` says `no matching peer`, your computer and the VPS are not
in the same Tailscale network. Confirm only after SSH connects through Tailscale
and opens `/home/app/fased`. If it does not connect, setup stops before
disabling root or password SSH.
If the original VPS login was password-only and no SSH public key is available,
setup stops before hardening; add your public key and rerun.

At the end of hosted onboarding, use both access paths:

- **Web dashboard:** open the printed `https://...ts.net/` URL in a browser on
  your own computer. That computer must be signed into the same Tailscale
  account. Save the gateway token in case the browser asks for it.
- **SSH terminal:** use regular SSH over Tailscale as `app` for CLI commands,
  updates, logs, and repairs. Run it from a computer signed into the same
  Tailscale network.

Then leave the original root bootstrap shell and reconnect as `app` over the
Tailscale network:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased status
fased dashboard
```

The `app` shell starts in `/home/app/fased`.

The raw Gateway port remains closed. `http://localhost:18789` is only the
advanced SSH tunnel fallback: it works on your local computer after you start
the tunnel shown by onboarding and keep that tunnel running.

Model/API setup has moved to `Agent > Models` for normal users. Existing
non-interactive provider flags still work for scripted installs, but first-run
interactive onboarding does not ask you to choose every provider anymore.

<Note>
Re-running the wizard does **not** wipe durable instance setup.
If an existing config is present, choose **Review settings** or **Repair sign-in**.
Review settings starts from the existing config and keeps wallets, Tailscale
account/device access, gateway port assumptions, mining/bond state, and firewall
state unless you explicitly edit those sections.
Repair sign-in clears only selected auth/session state. It keeps `fased.json`,
gateway token/password, gateway settings, wallet assignments, SAT mining,
Fased Network, plugins, Tailscale, firewall state, and wallet data.
CLI `fased onboard --reset` uses the same scoped repair flow and defaults to
`auth+sessions`; use `--reset-scope sessions|auth|auth+sessions`.
Use the explicit admin command `fased reset --scope ...` only when you intentionally want destructive config/state reset.
If the config is invalid or contains legacy keys, the wizard asks you to run `fased doctor` first.
</Note>

**Remote mode** only configures the local client to connect to a Gateway elsewhere.
It does **not** install or change anything on the remote host.
Remote only connects to an existing gateway. Run Local or Hosting onboarding on
the host first if the Gateway does not already exist.

## What it does not do

Onboarding gets the runtime online. It is not the whole operator path.

After onboarding, you usually continue into one of these:

- `/agents` in the Control UI for the Agent Setup checklist
- `Agent > Models` to add a model API key or sign in and choose model refs
- `Agent > Skills` to create, review, configure, edit, and allow abilities
- `Agent > Channels` to connect Telegram, Discord, WhatsApp, and other app messages
- `Agent > Services` to connect web/search, Gmail, Calendar, GitHub, browser/media, and APIs
- `Agent > Memory` and `Agent > Tasks` to archive sessions and schedule work
- [Dashboard](/web/dashboard) for normal day-to-day use
- [Build with Fased](/start/fased) for the sovereign runtime path
- [Wallet](/plugins/crypto/wallet-page) for wallet policy and wallet runtime
- [Mining](/plugins/crypto/mining-page) for SAT operator setup

## Wallet roles during onboarding

The wallet setup path can assign wallet purpose directly during onboarding.

The practical split is:

- `agent` purpose for user-facing Agent wallets
- one primary Agent wallet for fallback when no handle is supplied
- `mining` purpose for SAT participation
- `vault` purpose for manual-first storage or warm reserve
- Fased Network bond uses a selected Vault wallet

Chain type is separate from the name/id. Use `Agent` / `agent`, not `Agent SOL`; Wallet shows Solana separately.

When you create a wallet, the wizard lets you pick Agent, Mining, or Vault, then
choose the display name before creation. The permanent `walletId` is generated
from the selected purpose, not from the display name. The display name is fixed
after creation; create a new wallet if you need a different permanent label.

Only Agent and Vault can have multiple wallets:

- second Agent wallet: default id `agent-2`; display name can be `Agent 2`,
  `Receipts`, `Operations`, or another user label
- second Vault wallet: default id `vault-2`; display name can be `Vault 2`,
  `Cold`, `Archive`, or another user label

The onboarding wizard generates `agent-2`, `agent-3`, `vault-2`, `vault-3`,
and so on when those ids are already used. CLI wallet setup can also create
extra Agent or Vault wallets, but you must pass the intended `--wallet-id`
yourself.

Mining is one active configured wallet, normally `@wallet:mining`. To replace
it, stop mining, clear pending work and funds, delete the old Mining wallet
through guarded wallet management if needed, then create the new one.

Wallets are persistent machine state. Wizard repair never deletes them. Delete a
wallet only from wallet management, one wallet at a time, after saving recovery
material and typing the exact wallet id. Tailscale is also persistent machine
access; repair does not remove it, so log out or remove the device in Tailscale
only when you intentionally want to cut access.

Important distinction:

- mining wallet is the active SAT working wallet
- a Vault wallet can be assigned on Fased Network as the SAT lock-and-proof wallet
- Agent wallets are for reviewed sends, receipts, and explicitly granted wallet-connected workflows
- multiple Agent wallets are allowed, but risky actions should use explicit handles like `@wallet:agent`
- display name is only a label; handle is always `@wallet:<walletId>`
- wallet purpose is treated as permanent after creation; if you want a different
  purpose, create a new wallet instead of repurposing the old one

Only a Vault wallet should be selected for Fased Network bond. Agent and Mining wallets are rejected for bond authority.

## Add another agent

Use Control UI > Agents for the normal Agent creation path. The CLI
still supports `fased agents add <name>` for power users and automation.

What it sets:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes:

- Default workspaces follow `~/.fased/workspace-<agentId>`.
- Add channel or task bindings from Control UI > Agents.
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Full reference

For detailed step-by-step breakdowns, non-interactive scripting, Signal setup,
RPC API, and a full list of config fields the wizard writes, see the
[Wizard Reference](/reference/wizard).

## Related docs

- CLI command reference: [`fased onboard`](/cli/onboard)
- First-run setup matrix: [Setup Matrix](/start/setup-matrix)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)
