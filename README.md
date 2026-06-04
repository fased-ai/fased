<p align="center">
  <img src="docs/assets/fased-mark-color.svg" alt="Fased" width="96">
</p>

<h1 align="center">Fased Agent</h1>

<p align="center">
  Self-hosted agent node for chat, tools, skills, memory, wallet policy, SAT mining, and Fased Network participation.
</p>

<p align="center">
  <a href="https://github.com/fased-ai/fased/releases"><img src="https://img.shields.io/github/v/release/fased-ai/fased?style=for-the-badge" alt="Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License"></a>
  <a href="https://docs.fased.ai"><img src="https://img.shields.io/badge/docs-open-ff735c?style=for-the-badge" alt="Docs"></a>
  <a href="./SECURITY.md"><img src="https://img.shields.io/badge/security-policy-222?style=for-the-badge" alt="Security"></a>
</p>

**Fased Agent** is a self-hosted agent node. It brings models, channels, tools,
skills, services, files, sessions, memory, tasks, wallet policy, SAT mining, and
network activity into one browser Control UI that you operate.

Use it on your own machine for private chat and automation, or use the VPS
Hosting path for an always-on agent node with private access through Tailscale.

**Links:** [Install](#install) · [Docs](https://docs.fased.ai) ·
[Security](./SECURITY.md) · [Release checklist](./docs/reference/RELEASING.md) ·
[Repository](https://github.com/fased-ai/fased)

## Install

Public install is repo-backed:

### Local vs VPS Hosting

| Path          | Best for                                | Security posture                                                                                                                                                | Access dependency                                                            |
| ------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Local install | Personal laptop, desktop, dev box, WSL2 | Lowest setup risk. Gateway stays on your machine; a home router usually does not expose it to the public internet. Tailscale is optional.                       | Your local OS login.                                                         |
| VPS Hosting   | Always-on cloud node                    | Higher exposure by default because a VPS is internet-reachable. Hosted setup closes public admin ports and requires Tailscale for private dashboard/SSH access. | Your Tailscale account plus the VPS provider console for emergency recovery. |

If you lose access to the Tailscale account used for a hosted VPS, normal
dashboard and SSH access can be lost. Recovery then depends on the VPS
provider's web console/rescue mode/rebuild tools. Keep your Tailscale account
recovery options and VPS provider console access working.

### Local install

Use this on a laptop, desktop, dev box, or WSL2:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
```

After local setup:

1. Keep the dashboard tab that opens, or run `fased dashboard`.
2. Go to **Agent > Models** and connect a model provider.
3. Open **Chat** and send a test message.

Successful install output is intentionally short. If a step fails, the installer
prints the full log path under `~/.fased/logs/`.

On Windows, local install means WSL2/Ubuntu. Hosted VPS management is different:
use PowerShell or Windows Terminal with the Windows Tailscale app online unless
you intentionally installed and logged into Tailscale inside WSL too.

### VPS Hosting install

Use this on the VPS that will run Fased all the time. A 1 vCPU / 1 GB RAM VPS
can work as a minimum test node, but expect slow install/onboarding. For a
smoother public node, use at least 2 GB RAM; 2 vCPU / 4 GB RAM is more
comfortable.

Hosted setup uses two machines:

- **Your own computer:** opens the dashboard and runs SSH checks.
- **The VPS:** runs Fased Agent.

Start on your own computer:

| Your computer | Use this terminal              | Tailscale requirement                                                                                                                             |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows       | PowerShell or Windows Terminal | Install/sign into the Windows Tailscale app from [tailscale.com/download](https://tailscale.com/download). PowerShell can SSH into the Linux VPS. |
| macOS         | Terminal                       | Install/sign into the macOS Tailscale app.                                                                                                        |
| Linux         | Terminal                       | Install/start Tailscale on that Linux machine.                                                                                                    |
| WSL           | Advanced only                  | Either use PowerShell instead, or install/start Tailscale inside WSL too. Windows Tailscale does not automatically make WSL a Tailscale node.     |

Installing Tailscale from PowerShell is fine, but it still installs the Windows
Tailscale app/service. PowerShell uses that Windows Tailscale connection.

Other private-access systems are custom deployments. The standard hosted
installer does not configure or verify WireGuard, Headscale, ZeroTier, bastion
hosts, or manual SSH tunnels. If you replace Tailscale, you own dashboard
exposure, SSH policy, TLS, firewall rules, and recovery.

Do not paste the Linux install commands into PowerShell unless PowerShell is
already connected to the VPS over SSH. The commands below run **inside the VPS
SSH session**.

First SSH into the fresh VPS using the login your VPS provider gives you, often
`root@YOUR_PUBLIC_VPS_IP`:

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

Then run this on the VPS:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh

git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --hosting
```

Current installers try a clean fast-forward update from Git before building. If
you already started from an older installer and it stopped before updating,
update the checkout once and rerun:

```bash
cd ~/fased
git pull --ff-only origin main
./install.sh --hosting
```

If you SSH into a fresh VPS as `root`, the installer creates a non-root `app`
user, copies/clones the repo to `/home/app/fased`, and continues there. The
temporary root checkout is removed after successful hosted onboarding. During
Tailscale setup, copy the login URL printed in SSH and open it in your local
computer's browser.

The VPS must also join the same Tailscale tailnet before onboarding can finish
safely. When `sudo tailscale up --ssh` prints a login URL in the SSH terminal,
open that URL in your own device's browser. The VPS does not need a desktop
browser. A Tailscale auth key is only needed for unattended automation.

Before SSH/firewall lock-down, setup pauses and asks you to test terminal access
from your own computer:

```bash
tailscale ping YOUR_VPS_TAILSCALE_NAME
ssh app@YOUR_VPS_TAILSCALE_NAME
```

If `tailscale ping` says `no matching peer`, your computer and the VPS are not
in the same Tailscale network. Sign your computer into the same Tailscale
account, or re-authenticate Tailscale on the VPS, then rerun the check.

Only confirm after that command connects through Tailscale and opens
`/home/app/fased`. If it does not connect, setup stops before disabling root or
password SSH.
If the original VPS login was password-only and no SSH public key is available,
setup stops before hardening; add your public key and rerun.

At the end, onboarding prints two things you will normally use:

- **Web dashboard:** open the printed `https://...ts.net/` URL in a browser on
  your own computer. That computer must be signed into the same Tailscale
  account. Save the gateway token in case the browser asks for it.
- **SSH terminal:** use regular SSH over Tailscale as `app` for CLI commands,
  updates, logs, and repairs. Run it from a computer signed into the same
  Tailscale network.

After hosted onboarding completes, stop treating the original `root@...:~/fased`
shell as the operating shell. Open a new terminal on your own computer and use:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased status
fased dashboard
```

The `app` shell is a full Linux shell on the VPS and is configured to start in
`/home/app/fased`.

`http://localhost:18789` is only the advanced SSH tunnel fallback. It works on
your local computer after you start the tunnel shown by onboarding and leave
that tunnel running. The raw gateway port stays closed to the public internet.

`install.sh` runs onboarding by default. Use `./install.sh --no-onboard` only
when you want to install first and run onboarding later.

## Update

For a running install, use the CLI update path:

```bash
fased update status
fased update
```

On a hosted VPS, log in as the app user through Tailscale first:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

If the browser Control UI is healthy, you can also use **Update & Restart** from
the system/debug update area. Rerun `./install.sh` when you want
repair/reinstall behavior; it fast-forwards a clean Git checkout before
building. Use `./install.sh --no-git-update` only when testing local changes.

After install, open the dashboard, configure **Agent > Models**, send a first
browser chat, then add channels, skills, services, wallets, mining, and tasks
only as needed.

Read next:

- [Getting Started](https://docs.fased.ai/start/getting-started)
- [Install](https://docs.fased.ai/install)
- [VPS Hosting](https://docs.fased.ai/install/vps)
- [Onboarding Wizard](https://docs.fased.ai/start/wizard)
- [Control UI](https://docs.fased.ai/web/control-ui)
- [Dashboard](https://docs.fased.ai/web/dashboard)

## What Fased Runs

- Gateway, CLI, onboarding, local auth, device pairing, and browser Control UI
- Agent workbench for models, channels, services, skills, tools, memory,
  sessions, files, tasks, coordination, and programs
- Task ledger for scheduled work, webhooks, workflows, wallet approvals,
  marketplace records, mining events, ACP/subagent runs, and CLI/system activity
- Wallet UI with local signer integration, role-separated policy, approval
  review, and spend caps
- SAT mining runtime path with mining wallet separation, cycle history, and
  mining event records
- Fased Network, node presence, operator/bond surfaces, marketplace offers,
  plugin SDK, bundled skills, extensions, mobile/macOS app code, and public docs

## Product Model

Fased is Agent-first. Most normal setup starts from **Agents**:

- **Models** connects provider accounts and assigns primary, fallback, and task
  model roles.
- **Channels** connects message surfaces and routes them to the Agent.
- **Services** connects credentials and API surfaces.
- **Skills** and **Tools** decide what the selected Agent may use.
- **Tasks** defines schedules, webhook triggers, workflows, templates, and
  Programs, then shows one correlated activity ledger.
- **Wallets**, **Mining**, and **Marketplace** keep their own authority pages
  for actions that can spend, broadcast, mine, deliver, or change external state.

## Security Defaults

Fased is built around private access and explicit authority boundaries:

- Local dashboard links use a gateway token flow; local browser opens can be
  auth-ready without repeatedly pasting tokens.
- Remote access should stay private through Tailscale or another private
  network. Public internet exposure belongs behind a deliberate hardened
  deployment plan.
- New remote browser/device access requires pairing approval.
- Skills require explicit wallet, mining, service, or tool grants.
- Services connect credentials; Agent Tools and Skills decide what a selected
  Agent may use.
- Wallet pages own signing, caps, approval, and broadcast. Workflows can request
  or review wallet actions while spend authority stays in wallet policy.
- Marketplace and Mining pages own their state-changing controls. Agent Tasks
  records and reviews those actions.
- Advanced/Debug/Nodes are operator/admin surfaces for diagnostics and raw
  controls.

Read:

- [Security](https://docs.fased.ai/security)
- [Gateway Security](https://docs.fased.ai/gateway/security)
- [Wallet Page](https://docs.fased.ai/plugins/crypto/wallet-page)
- [Mining Page](https://docs.fased.ai/plugins/crypto/mining-page)

## Tasks And Workflows

Fased uses a ledger-backed workflow layer with constrained node types and shared
Agent activity records.

- **Task**: a saved scheduled definition for an Agent.
- **Trigger**: an HTTP/webhook entrypoint that can run an Agent prompt,
  heartbeat wake, or workflow target.
- **Workflow**: a saved multi-step procedure.
- **Graph**: a visual editor for the same workflow JSON/runtime.
- **Template**: a starter workflow such as wallet approval review, mining
  readiness/start gate, marketplace delivery/dispute, channel delivery review,
  media generation review, or service health check.
- **Program**: an Agent-scoped durable standing order that can propose work for
  review while grants still come from Tools, Skills, Wallets, and Mining policy.
- **Activity**: the ledger of what actually happened, grouped by correlation id.

This solves the old scattered-work problem: cron runs, webhooks, channel tasks,
media work, wallet approvals, marketplace records, mining events, ACP/subagents,
and CLI/system runs can be inspected from one Agent work surface while the
domain page still controls the risky action.

Read:

- [Automation](https://docs.fased.ai/automation)
- [Control UI Tasks](https://docs.fased.ai/web/control-ui)

## Wallets, Mining, And Marketplace

Wallets are role-separated:

- **Agent** wallets are for ordinary agent operations.
- **Mining** wallets are for SAT mining capital and mining actions.
- **Vault** wallets are for reserve/bond/operator roles.

Fased favors a self-hosted local signer and explicit policy over hosted wallet
abstraction. External wallet providers can make sense for managed custody,
multi-tenant products, or compliance-heavy deployments, but Fased's default
model keeps keys and approvals under the operator's runtime and policy.

Marketplace and Mining integration is intentionally task-ledger aware:

- Wallet approvals show spend/policy evidence.
- Mining events mirror readiness, start/stop, cycle, claim, recovery, and
  capital changes.
- Marketplace offer/order/delivery/dispute records can be reviewed from the
  activity stream while Marketplace remains the authority page.

## Docs By Goal

- First install: [Start](https://docs.fased.ai/start/getting-started)
- Local vs hosted: [Install](https://docs.fased.ai/install)
- Remote/private access: [Gateway](https://docs.fased.ai/gateway)
- Models: [Providers](https://docs.fased.ai/providers)
- Chat apps: [Channels](https://docs.fased.ai/channels)
- Skills and dependencies: [Tools](https://docs.fased.ai/tools)
- Wallets and mining: [Crypto Plugins](https://docs.fased.ai/plugins/crypto)
- Agent workbench: [Agents](https://docs.fased.ai/agents)
- Dashboard and browser UI: [Web](https://docs.fased.ai/web)
- Logs, usage, debug, nodes: [Diagnostics](https://docs.fased.ai/diagnostics)
- Security model: [Security](https://docs.fased.ai/security)
- Concepts and mental model: [Concepts](https://docs.fased.ai/concepts)

## Development

Common source commands:

```bash
pnpm install
pnpm build
pnpm test:fast
pnpm --dir ui test
pnpm ui:build
pnpm check:docs
```

Run locally:

```bash
pnpm dev
# or
pnpm fased gateway
```

Useful docs:

- [Contributing](./CONTRIBUTING.md)
- [Releasing](./docs/reference/RELEASING.md)
- [Security](./SECURITY.md)
- [Plugin license policy](./docs/reference/plugin-license-policy.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

## Root Layout

The root intentionally contains both product code and build/deploy control files:

- `src/`: gateway, CLI, providers, agents, tasks, wallet, mining, marketplace,
  plugin/runtime, and server logic
- `ui/`: browser Control UI
- `docs/`: public docs site
- `apps/`: macOS, iOS, Android, and shared app surfaces
- `extensions/`: bundled extensions and extension runtime code
- `skills/`: bundled skills and skill metadata
- `scripts/`: build, install, docs, release, and test scripts
- `tools/`: repo tooling and operator helpers
- `vendor/`: vendored third-party code that must keep its own notices
- `config/`: runtime and channel/provider configuration helpers
- `test/`: test fixtures and integration helpers
- `token/`: SAT/token technical materials
- `Dockerfile`, `docker-compose.yml`, `docker-setup.sh`, and
  `setup-podman.sh`: primary container entrypoints
- `deploy/`: secondary container, Fly, Render, and hosting configuration files

Root config files should stay at repository root unless the owning toolchain,
docs publisher, installer, and CI path are updated together.

## Legal, Attribution, And Risk

Fased is published under MIT with required third-party and copied-code notices.

Important:

- MIT permits modification and redistribution, but existing copyright and
  permission notices for copied material must be preserved.
- Third-party bundled code and assets are tracked in
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

Before using wallet, mining, federation, trading, marketplace, or similar
operator features, read:

- [LICENSE](./LICENSE)
- [SECURITY.md](./SECURITY.md)
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
- [Disclaimer](./docs/legal/disclaimer.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [Plugin license policy](./docs/reference/plugin-license-policy.md)

Fased software is not financial, investment, tax, legal, or operational advice.
Wallets, crypto, mining, federation, trading, marketplace, and news/market
workflows carry real risk.
