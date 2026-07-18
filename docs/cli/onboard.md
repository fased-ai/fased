---
summary: "CLI reference for `fased onboard`, including local versus hosting profile behavior"
read_when:
  - You want guided setup for gateway, workspace, auth, channels, and skills
title: "onboard"
---

# `fased onboard`

Interactive onboarding wizard for the self-hosted runtime.

Use it to set up:

- a local Agent runtime
- a hosted or VPS runtime
- a remote client connection to another runtime

## Related guides

- [Onboarding Wizard](/start/wizard)
- [Onboarding Overview](/start/onboarding-overview)
- [CLI Onboarding Reference](/start/wizard-cli-reference)
- [CLI Automation](/start/wizard-cli-automation)
- [Onboarding (macOS App)](/start/onboarding)

## Examples

```bash
fased onboard
fased onboard --flow quickstart
fased onboard --flow advanced
fased onboard --host-profile local
fased onboard --host-profile hosting --install-daemon
fased onboard --mode remote --remote-url ws://gateway-host:18789
```

Non-interactive custom provider:

```bash
fased onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --custom-compatibility openai
```

## Flow notes

- `quickstart`
  - minimal prompts, auto-generated gateway token
- `manual`
  - legacy alias for `advanced`
- `advanced`
  - full prompt path for bind, auth, and runtime options
- `--host-profile local`
  - local-first runtime path
- `--host-profile hosting`
  - hosted or VPS path with managed service expectations
  - install/sign into Tailscale on your own computer first
  - run the hosted Fased installer on the VPS; it starts Tailscale there and
    prints the browser login URL
  - keep admin access private through Tailscale rather than opening the raw gateway port publicly
- `--mode remote`
  - connect to an existing gateway instead of creating a new runtime

## Important flags

Host and Gateway:

- `--workspace <dir>`: Agent workspace directory.
- `--gateway-port <port>`: Gateway port.
- `--gateway-bind <loopback|tailnet|lan|auto|custom>`: listener binding.
- `--gateway-auth <token|password>`: Gateway auth mode.
- `--gateway-token <token>` / `--gateway-password <password>`: explicit
  Gateway credential.
- `--tailscale <off|serve|funnel>`: Tailscale exposure mode.
- Tailscale authentication is a root Hosting-installer responsibility, not an
  `fased onboard` option. Normal installs use the browser login URL. For
  unattended provisioning, the verified standalone installer accepts only
  `--ts-authkey-file <root-owned-mode-0600-file>` and rejects raw key arguments.
- `--install-daemon`, `--no-install-daemon`, `--skip-daemon`: service install
  choice.
- `--daemon-runtime <node|bun>`: service runtime.

Wallet:

- `--wallet-enabled` / `--wallet-disabled`: include or skip wallet setup.
- `--wallet-providers <ids>`: enabled wallet providers CSV.
- `--wallet-default-provider <id>`: default wallet provider.
- `--wallet-tool-access-mode <owner-only|allowlist|all>`: which Agents may use
  wallet tools.
- `--wallet-tool-access-allow-agents <ids>`: CSV allowlist for wallet tools.

Automation:

- `--skip-channels`, `--skip-skills`, `--skip-health`, `--skip-ui`: skip
  optional setup sections.
- `--no-fast-health`: use the full health path instead of the quick path.
- `--node-manager <npm|pnpm|bun>`: package manager used for skill/node setup.
- `--json`: print a JSON summary. It does not imply `--non-interactive`.

Fastest first interaction after onboarding:

- `fased dashboard`

## Repair mode

`fased onboard --reset` is a safe repair path, not a factory reset. It clears
selected auth/session state before continuing through onboarding and keeps
`fased.json`, gateway token/password, gateway settings, wallet assignments, SAT
mining, Fased Network, plugins, Tailscale, firewall state, and wallet material.

```bash
fased onboard --reset
fased onboard --reset --reset-scope sessions
fased onboard --reset --reset-scope auth
fased onboard --reset --reset-scope auth+sessions
```

Use `fased reset --scope ...` only for destructive admin config/state reset.

For hosted machines, the intended access path is:

- tailnet browser access, Tailscale Serve, or SSH tunnel
- **not** direct public exposure of the raw gateway listener

## Custom providers

Use onboarding when you want to connect:

- OpenAI-compatible endpoints
- Anthropic-compatible endpoints
- other hosted model APIs not yet given a dedicated preset

## SAT runtime ids

For SAT mining, mint, and bond ids:

- pre-launch public installs keep `config/sat-runtime.env` empty
- mainnet IDs are written by Mining Sync after the signed manifest verifies
- explicit devnet or local testing can set all four IDs through env or the file

Normal mainnet users should not paste IDs during onboarding. Wait for official
Satcoin launch proof, then use the Mining page Sync control.

## Wallet note

Current docs standardize on the self-hosted wallet path.

Canonical unattended wallet backend:

- `local-socket-signer`

You can finish onboarding before attaching any wallet roles.

## Common follow-up commands

```bash
fased configure
fased agents add <name>
fased dashboard
```

<Note>
`--json` does not imply `--non-interactive`. Use `--non-interactive` explicitly
for scripts.
</Note>
