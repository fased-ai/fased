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

Normal model providers, channels, skills, services, hooks, memory activation,
tasks, and Agent assembly continue in the Control UI after onboarding.
Non-interactive provider flags remain available for scripted installs.

Remote mode configures this machine to connect to a gateway elsewhere.
It does not install or modify anything on the remote host.

## Local flow details

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the
Control UI instead of opening a browser.
If Control UI assets are missing, rerun `./install.sh` from the Fased checkout.
If Fased is already installed, run `fased doctor --fix` for guided repair.
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

    Sets `agents.defaults.model` to the first executable model returned by the
    authenticated `openai-codex` runtime when the model is unset
    or `openai/*`.

  </Accordion>
  <Accordion title="OpenAI API key">
    Uses `OPENAI_API_KEY` if present or prompts for a key, then stores the credential in auth profiles.

    Sets `agents.defaults.model` to `openai/gpt-5.6` when model is unset,
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
  - For custom providers, non-interactive `ref` mode stores
    `models.providers.<id>.apiKey` as:

    ```json
    { "source": "env", "provider": "default", "id": "CUSTOM_API_KEY" }
    ```

  - In that custom-provider case, `--custom-api-key` requires `CUSTOM_API_KEY` to be set; otherwise onboarding fails fast.

- Existing plaintext setups continue to work unchanged.

<Note>
Headless and server tip: complete OAuth on a machine with a browser, then copy
`~/.fased/credentials/oauth.json` (or `$FASED_STATE_DIR/credentials/oauth.json`)
to the gateway host.
</Note>

## Outputs and internals

Typical fields in `~/.fased/fased.json`:

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
