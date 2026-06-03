---
summary: "Complete reference for CLI onboarding host/security, wallet, outputs, and internals"
read_when:
  - You need detailed behavior for fased onboard
  - You are debugging onboarding results or integrating onboarding clients
title: "CLI Onboarding Reference"
sidebarTitle: "CLI reference"
---

# CLI Onboarding Reference

This page is the full reference for `fased onboard`.
For the short guide, see [Onboarding Wizard (CLI)](/start/wizard). For the
Local/Hosting/Remote decision, see [First-run Setup Matrix](/start/setup-matrix).

## What the wizard does

Local mode (default) walks you through:

- QuickStart or Manual flow selection
- Local or Hosting setup profile
- Existing config update or auth/session repair
- Workspace location and bootstrap files
- Gateway settings (port, bind, auth)
- Fased Network / federation setup when selected
- Native signer and wallet setup
- Optional singleton Mining wallet setup
- Hosting security when the Hosting profile is selected
- Daemon install, health check, and Control UI/TUI finalization

Normal model providers, channels, skills, services, hooks, memory activation,
tasks, and Agent assembly continue in the Control UI after onboarding.
Non-interactive provider flags remain available for scripted installs.

Remote mode configures this machine to connect to a gateway elsewhere.
It does not install or modify anything on the remote host.

## Local flow details

<Steps>
  <Step title="QuickStart or Manual">
    - QuickStart applies conservative defaults for a first local Gateway.
    - Manual exposes the full sequence.
  </Step>
  <Step title="Setup profile">
    - Local is for this laptop, desktop, or dev box.
    - Local on a VPS means no SSH/firewall hardening.
    - Hosting is for a VPS or always-on server and requires Tailscale.
    - Hosting on personal Linux changes SSH/firewall behavior.
  </Step>
  <Step title="Existing config detection">
    - If `~/.fased/fased.json` exists, choose Update settings or Repair auth/sessions.
    - Update settings starts from the existing config and updates explicit setup sections while preserving wallet keystores, Tailscale account/device access, gateway port assumptions, and firewall state unless you edit those sections.
    - Re-running the wizard does not wipe durable instance setup.
    - Repair auth/sessions clears only the selected model/OAuth credential state and/or chat/session history.
    - Repair keeps `fased.json`, gateway token/password, gateway settings, wallet assignments, SAT mining, Fased Network, plugins, Tailscale, and firewall state.
    - CLI `fased onboard --reset` defaults to `auth+sessions`; use `--reset-scope sessions|auth|auth+sessions`.
    - If config is invalid or contains legacy keys, the wizard stops and asks you to run `fased doctor` before continuing.
    - Repair uses `trash` and offers scopes:
      - Sessions only
      - Auth only
      - Auth + sessions
    - Destructive config/state reset is not a normal onboarding path. Use the explicit admin command `fased reset --scope ...` only when you intentionally want to remove config/state.
  </Step>
  <Step title="Workspace">
    - Default `~/.fased/workspace` (configurable).
    - Seeds workspace files needed for first-run bootstrap ritual.
    - Workspace layout: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - The connection point for Control UI, CLI, WebChat, channels, and remote clients.
    - Prompts for port, bind, and auth mode.
    - Recommended: keep token auth enabled even for loopback so local WS clients must authenticate.
    - Disable auth only if you fully trust every local process.
    - Non-loopback binds still require auth.
    - Local Tailscale is hidden from the basic path. Hosting requires Tailscale.
  </Step>
  <Step title="Fased Network">
    - Optional federation, managed route, and public network setup.
    - Fased Network is not required for local chat.
  </Step>
  <Step title="Signer and wallet">
    - Wallets are for policy-bound actions, not required for chat.
    - Agent, Mining, and Vault roles stay separate.
  </Step>
  <Step title="Control UI setup">
    - On local and Tailscale-hosted starts, the wizard opens an auth-ready
      Control UI link. The browser exchanges the token for a session and strips
      the token from the URL.
    - `/agents`: create or select the Agent workspace.
    - `Agent > Models`: add model API keys or sign in and choose model refs.
    - `Agent > Skills`: create, review, install, configure, edit, and allow skills.
    - `Agent > Channels`: connect apps and route them to Agents.
    - `Agent > Services`: connect Gmail, Calendar, GitHub, web/search, browser/media, and APIs.
    - `Agent > Memory` and `Agent > Tasks`: enable archives and schedules when needed.
  </Step>
  <Step title="Hosting security">
    - Runs only for the Hosting profile.
    - Applies Tailscale-first admin access and host hardening where supported.
  </Step>
  <Step title="Finish">
    - Daemon install: LaunchAgent on macOS or systemd user unit on Linux/WSL2.
    - Health check: starts gateway if needed and runs `fased health`.
    - Control UI/TUI final prompt and readiness summary.
    - Summary and next steps, including iOS, Android, and macOS app options.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
Save the printed Gateway token. It is the recovery token for a new browser,
another machine in your tailnet, or a future `fased dashboard --no-open` link.
</Note>

## Remote mode details

Remote mode configures this machine to connect to a gateway elsewhere.

<Info>
Remote mode does not install or modify anything on the remote host.
Remote only connects to an existing Gateway.
</Info>

What you set:

- Remote gateway URL (`ws://...`)
- Token if remote gateway auth is required (recommended)

<Note>
- If gateway is loopback-only, use SSH tunneling or a tailnet.
- Discovery hints:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Auth and model options

Normal interactive onboarding skips this section and sends you to
`Agent > Models`. The options below remain for scripted/non-interactive onboarding and
explicit CLI provider setup.

<AccordionGroup>
  <Accordion title="Anthropic sign-in (Claude Code OAuth)">
    Opens an Anthropic sign-in URL. After signing in, paste the Anthropic
    authorization code if the wizard asks for it.
    More detail: [Anthropic](/providers/anthropic).
  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Run `claude setup-token` on any machine, then paste the token.
    You can name it; blank uses default.
    More detail: [Anthropic](/providers/anthropic).
  </Accordion>
  <Accordion title="Anthropic API key">
    Uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
    More detail: [Anthropic](/providers/anthropic).
  </Accordion>
  <Accordion title="OpenAI sign-in (existing local credential)">
    If `~/.codex/auth.json` exists, the wizard can reuse the existing OpenAI
    sign-in credential.
  </Accordion>
  <Accordion title="OpenAI sign-in (ChatGPT OAuth)">
    Browser flow through OpenAI sign-in. Internally this still uses the legacy
    `openai-codex` compatibility route until the runtime route is renamed.

    Sets `agents.defaults.model` to `openai-codex/gpt-5.5` when model is unset
    or `openai/*`.

  </Accordion>
  <Accordion title="OpenAI API key">
    Uses `OPENAI_API_KEY` if present or prompts for a key, then stores the credential in auth profiles.

    Sets `agents.defaults.model` to `openai/gpt-5.5` when model is unset,
    `openai/*`, or `openai-codex/*`.

  </Accordion>
  <Accordion title="Chutes sign-in">
    Chutes sign-in requires a Chutes OAuth app client id (`cid_...`). The
    wizard asks for the client id first, then generates the Chutes sign-in URL.
    More detail: [Chutes](/providers/chutes).
  </Accordion>
  <Accordion title="Chutes API key">
    Paste a Chutes API key (`cpk_...`) for normal Chutes model access.
    More detail: [Chutes](/providers/chutes).
  </Accordion>
  <Accordion title="xAI (Grok)">
    Supports browser sign-in, device-code sign-in for remote hosts, or
    `XAI_API_KEY`. In the Control UI, use **Agent > Models > xAI**.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`).
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Stores the key for you.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Prompts for `AI_GATEWAY_API_KEY`.
    More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Prompts for account ID, gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Config is auto-written.
    More detail: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Prompts for `SYNTHETIC_API_KEY`.
    More detail: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) and Kimi Coding configs are auto-written.
    More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Custom provider">
    Works with OpenAI-compatible and Anthropic-compatible endpoints.

    Interactive onboarding supports the same API key storage choices as other provider API key flows:
    - **Paste API key now** (plaintext)
    - **Use secret reference** (env ref or configured provider ref, with preflight validation)

    Non-interactive flags:
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key` (optional; falls back to `CUSTOM_API_KEY`)
    - `--custom-provider-id` (optional)
    - `--custom-compatibility <openai|anthropic>` (optional; default `openai`)

  </Accordion>
  <Accordion title="Skip">
    Leaves auth unconfigured.
  </Accordion>
</AccordionGroup>

Model behavior:

- Pick default model from detected options, or enter provider and model manually.
- Wizard runs a model check and warns if the configured model is unknown or missing auth.

Credential and profile paths:

- OAuth credentials: `~/.fased/credentials/oauth.json`
- Auth profiles (API keys + OAuth): `~/.fased/agents/<agentId>/agent/auth-profiles.json`

API key storage mode:

- Default onboarding behavior persists API keys as plaintext values in auth profiles.
- `--secret-input-mode ref` enables reference mode instead of plaintext key storage.
  In interactive onboarding, you can choose either:
  - environment variable ref (for example `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`)
  - configured provider ref (`file` or `exec`) with provider alias + id
- Interactive reference mode runs a fast preflight validation before saving.
  - Env refs: validates variable name + non-empty value in the current onboarding environment.
  - Provider refs: validates provider config and resolves the requested id.
  - If preflight fails, onboarding shows the error and lets you retry.
- In non-interactive mode, `--secret-input-mode ref` is env-backed only.
  - Set the provider env var in the onboarding process environment.
  - Inline key flags (for example `--openai-api-key`) require that env var to be set; otherwise onboarding fails fast.
  - For custom providers, non-interactive `ref` mode stores `models.providers.<id>.apiKey` as `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`.
  - In that custom-provider case, `--custom-api-key` requires `CUSTOM_API_KEY` to be set; otherwise onboarding fails fast.
- Existing plaintext setups continue to work unchanged.

<Note>
Headless and server tip: complete OAuth on a machine with a browser, then copy
`~/.fased/credentials/oauth.json` (or `$FASED_STATE_DIR/credentials/oauth.json`)
to the gateway host.
</Note>

## Outputs and internals

Typical fields in `~/.fased/fased.json`:

- `agents.defaults.workspace`
- `gateway.*` (mode, bind, auth, tailscale)
- `session.dmScope` (local onboarding defaults this to `per-channel-peer` when unset; existing explicit values are preserved)
- wallet runtime/provider/env fields when local signer setup is enabled
- `plugins.entries.sat-mining.config.walletId` when the singleton Mining wallet is configured
- `models.providers` / `agents.defaults.model` only when explicit non-interactive provider flags are used
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`fased agents add` writes `agents.list[]` and optional `bindings`.

WhatsApp credentials go under `~/.fased/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.fased/agents/<agentId>/sessions/`.

Channels, skills, hooks, services, and extensions are configured from the
Control UI after onboarding, mostly from the selected Agent. Advanced CLI/config
paths remain available for automation and repair.

Gateway wizard RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Clients (macOS app and Control UI) can render steps without re-implementing onboarding logic.

Signal setup behavior:

- Downloads the appropriate release asset
- Stores it under `~/.fased/tools/signal-cli/<version>/`
- Writes `channels.signal.cliPath` in config
- JVM builds require Java 21
- Native builds are used when available
- Windows uses WSL2 and follows Linux signal-cli flow inside WSL

## Related docs

- Onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)
- Automation and scripts: [CLI Automation](/start/wizard-cli-automation)
- Command reference: [`fased onboard`](/cli/onboard)
