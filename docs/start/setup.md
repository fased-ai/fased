---
summary: "Advanced setup and development workflows for Fased"
read_when:
  - Setting up a new machine
  - You want “latest + greatest” without breaking your personal setup
title: "Setup"
---

# Setup

<Note>
If you are setting up for the first time, start with [Getting Started](/start/getting-started).
For wizard details, see [Onboarding Wizard](/start/wizard).
</Note>

Reviewed for the current Agent-centered Control UI.

## TL;DR

- **Tailoring lives outside the repo:** `~/.fased/workspace` (workspace) + `~/.fased/fased.json` (config).
- **Stable workflow:** use the repo-backed installer, then finish setup in
  `Agent > Models`, `Agent > Skills`, `Agent > Channels`, and
  `Agent > Services`.
- **Bleeding edge workflow:** run the Gateway yourself via `pnpm gateway:watch`,
  then let the app or browser UI attach in Local mode.

## Prereqs (from source)

- Node 24 recommended, or Node 22.14+ with `node:sqlite`
- `pnpm`
- Docker (optional; only for containerized setup/e2e — see [Docker](/install/docker))

## Tailoring strategy (so updates don’t hurt)

If you want “100% tailored to me” _and_ easy updates, keep your customization in:

- **Config:** `~/.fased/fased.json` (JSON/JSON5-ish)
- **Workspace:** `~/.fased/workspace` (skills, prompts, memories; make it a private git repo)

Bootstrap once:

```bash
fased setup
```

If `fased` is missing, run `./install.sh --no-onboard` from the repo checkout to
install the CLI, then run the command again.

## Run the Gateway from this repo

After `pnpm build`, you can run the packaged CLI directly:

```bash
node fased.mjs gateway run --port 18789 --bind loopback --verbose
```

## Stable workflow

1. Install with the repo-backed installer:

```bash
./install.sh
```

2. Open the Control UI:

```bash
fased dashboard
```

3. Finish the selected Agent:

- `Agent > Models`: provider auth and model refs
- `Agent > Skills`: skill library, plugin-catalog review, local skill creation, and per-Agent access
- `Agent > Channels`: chat app accounts and routes
- `Agent > Services`: web/search, Gmail, Calendar, GitHub, browser/media, and APIs

4. Sanity check:

```bash
fased health
```

The macOS companion app can manage the local Gateway and platform permissions,
but the browser Control UI remains the clearest setup surface for public docs.

If onboarding is not available in your build:

- Run `fased setup`, then start the Gateway manually with `fased gateway`.

## Bleeding edge workflow (Gateway in a terminal)

Goal: work on the TypeScript Gateway, get hot reload, keep the macOS app UI attached.

### 0) (Optional) Run the macOS app from source too

If you also want the macOS app on the bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1) Start the dev Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` runs the gateway in watch mode and reloads on TypeScript changes.

### 2) Point the macOS app at your running Gateway

In **FasedAgent.app**:

- Connection Mode: **Local**
  The app will attach to the running gateway on the configured port.

### 3) Verify

- In-app Gateway status should read **“Using existing gateway …”**
- Or via CLI:

```bash
fased health
```

### Common footguns

- **Wrong port:** Gateway WS defaults to `ws://127.0.0.1:18789`; keep app + CLI on the same port.
- **Where state lives:**
  - Credentials: `~/.fased/credentials/`
  - Sessions: `~/.fased/agents/<agentId>/sessions/`
  - Logs: `/tmp/fased/`

## Credential storage map

Use this when debugging auth or deciding what to back up:

- **WhatsApp**: `~/.fased/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env or `channels.telegram.tokenFile`
- **Discord bot token**: config/env (token file not yet supported)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**:
  - `~/.fased/credentials/<channel>-allowFrom.json` (default account)
  - `~/.fased/credentials/<channel>-<accountId>-allowFrom.json` (non-default accounts)
- **Model auth profiles**: `~/.fased/agents/<agentId>/agent/auth-profiles.json`
- **File-backed secrets payload (optional)**: `~/.fased/secrets.json`
- **Shared OAuth credentials**: `~/.fased/credentials/oauth.json`
  More detail: [Security](/gateway/security#credential-storage-map).

## Updating (without wrecking your setup)

- Keep `~/.fased/workspace` and `~/.fased/` as “your stuff”; don’t put personal prompts/config into the `fased` repo.
- Updating source: `git pull` + `pnpm install` (when lockfile changed) + keep using `pnpm gateway:watch`.

## Linux (systemd user service)

Linux installs use a systemd **user** service. By default, systemd stops user
services on logout/idle, which kills the Gateway. Onboarding attempts to enable
lingering for you (may prompt for sudo). If it’s still off, run:

```bash
sudo loginctl enable-linger $USER
```

For always-on or multi-user servers, consider a **system** service instead of a
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + examples)
- [Discord](/channels/discord) and [Telegram](/channels/telegram) (reply tags + replyToMode settings)
- [Fased assistant setup](/start/fased)
- [macOS app](/platforms/macos) (gateway lifecycle)
