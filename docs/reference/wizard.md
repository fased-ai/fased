---
summary: "Full reference for the CLI onboarding wizard: every step, flag, and config field"
read_when:
  - Looking up a specific wizard step or flag
  - Automating onboarding with non-interactive mode
  - Debugging wizard behavior
title: "Onboarding Wizard Reference"
sidebarTitle: "Wizard Reference"
---

# Onboarding Wizard Reference

This is the full reference for the `fased onboard` CLI wizard.
For a high-level overview, see [Onboarding Wizard](/start/wizard).

## Flow details (local mode)

    - macOS: LaunchAgent
      - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux (and Windows via WSL2): systemd user unit
      - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - **Runtime selection:** Node (recommended; required for WhatsApp/Telegram). Bun is **not recommended**.

  </Step>
  <Step title="Health check">
    - Starts the Gateway (if needed) and runs `fased health`.
    - Tip: `fased status --deep` adds gateway health probes to status output (requires a reachable gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Lets you choose a node manager: **npm / pnpm** (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
    - After onboarding, manage creation, install/review, dependency health,
      configuration, and per-Agent access from **Agent > Skills**.
      Wallet-capable skills still need explicit Wallet > Skill Grants before
      they can use wallets.
  </Step>
  <Step title="Finish">
    - Summary + next steps, including iOS/Android/macOS apps for extra features.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If the Control UI assets are missing, rerun `./install.sh` from the Fased
checkout. If Fased is already installed, run `fased doctor --fix` for guided
repair.
</Note>

## After onboarding

The wizard gets a working baseline onto disk. Normal day-to-day setup now lives under the selected
Agent:

- **Agent > Models**: provider accounts plus primary, fallback, and task model refs for that Agent.
- **Agent > Channels**: install and configure the six public channel add-ons
  (Telegram, Discord, WhatsApp, Slack, Feishu, and Google Chat), plus configure source-maintained
  bundled channel extensions already present in the runtime.
- **Agent > Skills**: create, review/install, configure, test, and allow skills for that Agent.
- **Agent > Tools**: per-Agent tool allow/deny policy only. Credentials belong in Services or Skills.
- **Agent > Memory**: session-memory status, roots, archive health, and per-Agent memory diagnostics.
- **Agent > Services**: service credentials and tests such as web search, GitHub, Gmail, and media.
- **Agent > Tasks**: scheduled work for that Agent; coordination stays separate from task definitions.

Operator/admin surfaces are separate:

- **Dashboard** (`/dash`) is the widget overview.
- **Usage** is the local token/cost history.
- **Logs** tails gateway logs.
- **Advanced** (`/config`) contains Config, Debug, and Nodes tabs for raw or operator-only diagnostics.

## Non-interactive mode

Use `--non-interactive` to automate or script onboarding:

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Add `--json` for a machine‑readable summary.

<Note>
`--json` does **not** imply non-interactive mode. Use `--non-interactive` (and `--workspace`) for scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    fased onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    fased onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    fased onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    fased onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    fased onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    fased onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    fased onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Add agent (non-interactive)

```bash
fased agents add work \
  --workspace ~/.fased/workspace-work \
  --model openai-codex/gpt-5.5 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (macOS app, Control UI) can render steps without re‑implementing onboarding logic.

## Signal setup (signal-cli)

The wizard can install `signal-cli` from GitHub releases:

- Downloads the appropriate release asset.
- Stores it under `~/.fased/tools/signal-cli/<version>/`.
- Writes `channels.signal.cliPath` to your config.

Notes:

- JVM builds require **Java 21**.
- Native builds are used when available.
- Windows uses WSL2; signal-cli install follows the Linux flow inside WSL.

## What the wizard writes

Typical fields in `~/.fased/fased.json`:

- `agents.defaults.workspace`
- `agents.defaults.model`, auth profiles, and `models.providers` entries as needed for the selected provider
- `gateway.*` (mode, bind, auth, tailscale)
- `session.dmScope` (behavior details: [CLI Onboarding Reference](/start/wizard-cli-reference#outputs-and-internals))
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Channel allowlists for Slack, Discord, Matrix, and Microsoft Teams when you
  opt in during the prompts. Names resolve to IDs when possible.
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`fased agents add` writes `agents.list[]` and optional `bindings`.

WhatsApp credentials go under `~/.fased/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.fased/agents/<agentId>/sessions/`.

Some channels are delivered as plugins. The wizard installs the six published
official channel add-ons only when selected. Other advanced channels use their
bundled source-maintained extension when present; their individual pages state
any additional runtime dependency.

## Related docs

- Wizard overview: [Onboarding Wizard](/start/wizard)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Config reference: [Gateway configuration](/gateway/configuration)
- Channels: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram),
  [Discord](/channels/discord), [Google Chat](/channels/googlechat),
  [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage),
  [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
