<p align="center">
  <img src="docs/assets/fased-mark-color.svg" alt="Fased" width="96">
</p>

<h1 align="center">Fased Agent</h1>

<p align="center">
  <strong>Run your own agent for tasks, wallets, services, and SAT mining.</strong>
  <br>
  Run Agent. Mine SAT. Build Trust.
</p>

<p align="center">
  <a href="https://github.com/fased-ai/fased/releases"><img src="https://img.shields.io/github/v/release/fased-ai/fased?style=for-the-badge" alt="Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License"></a>
  <a href="https://docs.fased.ai"><img src="https://img.shields.io/badge/docs-open-ff735c?style=for-the-badge" alt="Docs"></a>
  <a href="./SECURITY.md"><img src="https://img.shields.io/badge/security-policy-222?style=for-the-badge" alt="Security"></a>
</p>

**Fased Agent** is the agent you run yourself. Use it for tasks, wallets,
services, and SAT mining from one browser Control UI.

Run it on your own machine, or use the VPS Hosting path when the agent needs to
stay online.

**Links:** [Install](#install) · [Docs](https://docs.fased.ai) ·
[Security](./SECURITY.md) · [Release checklist](./docs/reference/RELEASING.md) ·
[Repository](https://github.com/fased-ai/fased)

## Install

Public install is repo-backed:

### Local vs VPS Hosting

| Path          | Best for                                                                               | Security posture                                                                                                                                                | Access dependency                                                            |
| ------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Local install | Your own computer: macOS Terminal, Windows with WSL2 Ubuntu, Linux desktop, or dev box | Lowest setup risk. Gateway stays on your machine; a home router usually does not expose it to the public internet. Tailscale is optional.                       | Your local OS login.                                                         |
| VPS Hosting   | Always-on cloud node                                                                   | Higher exposure by default because a VPS is internet-reachable. Hosted setup closes public admin ports and requires Tailscale for private dashboard/SSH access. | Your Tailscale account plus the VPS provider console for emergency recovery. |

If you lose access to the Tailscale account used for a hosted VPS, normal
dashboard and SSH access can be lost. Recovery then depends on the VPS
provider's web console/rescue mode/rebuild tools. Keep your Tailscale account
recovery options and VPS provider console access working.

### Local install

Use this on your own machine:

- **macOS:** run the command in Terminal.
- **Windows:** install WSL2 with Ubuntu, then run the command inside the Ubuntu
  shell.
- **Linux:** run the command in your distro terminal.

Windows requires Windows 11 or Windows 10 version 2004/build 19041 or newer.
Open PowerShell **as Administrator** only to install WSL2:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if requested, open the **Ubuntu** application, create the Linux
username/password on first launch, and run the Fased command below in that
Ubuntu shell. Do not run the Fased installer in PowerShell, Command Prompt, Git
Bash, or native Windows Node.js. Fased wallet signing requires Unix sockets and
therefore runs through WSL2 on Windows.

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
```

After local setup:

1. Keep the dashboard tab that opens, or run `fased dashboard`.
2. Go to **Agent > Models** and connect a model provider.
3. Open **Chat** and send a test message.

Successful install output is intentionally short. If a step fails, the installer
prints the full log path under `~/.fased/logs/`.

If `~/.fased` already exists, the installer keeps it. Normal upgrades preserve
sessions, wallets, provider keys, channel settings, mining/bond state, and
gateway tokens. Advanced reset/test installs use explicit environment variables
documented in the installer reference.

If old channel credentials create warnings, run `fased doctor --fix`; it can
disable stale channel entries without deleting wallets or provider secrets.
Local setup finishes with a health check for service path, token match,
dashboard HTTP 200, and gateway online state. Later, use `fased health` as the
single pass/fail check for the running Gateway. Use `fased health --verbose`
only when you want optional channel details.

On Windows, local install means WSL2/Ubuntu. Hosted VPS management is different:
use PowerShell or Windows Terminal with the Windows Tailscale app online unless
you intentionally installed and logged into Tailscale inside WSL too.

### VPS Hosting install

Use this on the VPS that will run Fased all the time. Ubuntu LTS is the
recommended default for a first hosted setup. Debian is close to the same path.
Fedora/RHEL-family and other Linux VPS systems can work, but use their
OS-specific package-manager commands when a minimal image is missing basic
tools.

A 1 vCPU / 1 GB RAM VPS can work as a minimum test node, but expect slow
install/onboarding. For a smoother public node, use at least 2 GB RAM; 2 vCPU /
4 GB RAM is more comfortable.

Hosted setup uses two machines:

- **Your own computer:** opens the dashboard and runs SSH checks.
- **The VPS:** runs Fased Agent.

Start on your own computer by installing/signing into Tailscale with the same
account you will use for the VPS. Windows users should use PowerShell or Windows
Terminal with the Windows Tailscale app. macOS users should use Terminal with
the macOS Tailscale app. Linux users should install Tailscale for their distro.
Before you start the VPS installer, shut down local VPNs such as Mullvad,
Proton VPN, NordVPN, corporate VPN clients, and browser/device VPN apps. Other
VPNs can override Tailscale DNS, firewall rules, or `100.x` routing. Re-enable
them only after Tailscale SSH and the dashboard work.
The full OS-specific commands are kept in the tabbed
[VPS Hosting install docs](https://docs.fased.ai/install#vps-hosting-install).

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

Then follow the [pre-execution verified VPS bootstrap](https://docs.fased.ai/install/vps#3-install-fased-and-connect-through-tailscale).
It downloads the exact tagged `install.sh` release asset and its attestation
bundle, verifies repository/tag/workflow/GitHub-runner provenance with
`gh attestation verify`, and only then runs the script as root. Do not pipe a
moving or unverified script directly into a root shell.

The Fased installer bootstraps the attested hosted runtime itself. A fresh VPS
does not need `git clone`; the installer installs the supported system tools and
Node when the OS package manager supports auto-install, then activates the
exact tagged runtime instead of building an app-owned source checkout.
If a minimal VPS image does not have `curl`, use the OS tab in the install docs
to install only the downloader first, then rerun the same hosted command.

If an earlier install stopped before creating the `app` runtime, repeat the
same verified tagged bootstrap from the provider root console. Use the
documented `--repair-hosting` path for an existing installation; do not repair
Hosting from a moving `main` checkout.

If you SSH into a fresh VPS as `root`, the installer creates a non-root `app`
user, copies/clones the repo to `/home/app/fased`, and continues there. The
temporary root checkout is removed after successful hosted onboarding. During
Tailscale setup, copy the login URL printed in SSH and open it in your local
computer's browser.

The installer adds the VPS to the same Tailscale tailnet before onboarding can
finish safely. When Fased prints a Tailscale login URL in the SSH terminal,
open that URL in your own device's browser. The VPS does not need a desktop
browser. A Tailscale auth key is only needed for unattended automation.

Before SSH/firewall lock-down, setup pauses and asks you to test terminal access
from your own computer. That computer must have Tailscale installed, running,
and signed into the same tailnet as the VPS. Do not run the check commands
inside the VPS SSH session.

If your own computer says `tailscale: command not found`, install Tailscale on
your own computer first. Use the command for your local PC OS, not the VPS OS.
Those commands are in the tabbed install docs. Do not continue until
`tailscale status` shows your local computer online and `tailscale ip -4`
prints a `100.x.x.x` address. If status says it cannot connect to local
`tailscaled`, start the local Tailscale service, rerun `sudo tailscale up`, and
sign in. A separate VPN on your own computer can interfere with Tailscale DNS
or routing; if ping/SSH cannot reach the VPS, disconnect the other VPN or allow
Tailscale traffic and try again.

If `tailscale ping 100.x.x.x` works but
`ssh app@YOUR_VPS_TAILSCALE_NAME` fails with a hostname/DNS error, Tailscale is
connected but MagicDNS is being blocked or overridden, often by the other VPN.
Disconnect the other VPN, fix its DNS split-tunnel rules, or use the Tailscale
IP directly:

```bash
tailscale ping YOUR_VPS_TAILSCALE_NAME
ssh app@YOUR_VPS_TAILSCALE_NAME
ssh app@100.x.x.x
```

If `tailscale ping` says `no matching peer`, your computer and the VPS are not
in the same Tailscale network. Sign your computer into the same Tailscale
account, or re-authenticate Tailscale on the VPS, then rerun the check.

Only confirm after that command connects through Tailscale and opens
`/home/app/fased`. If it does not connect, setup stops before disabling root or
password SSH.
If the original VPS login was password-only and no SSH public key is available
to copy, the wizard uses Tailscale SSH first:

```bash
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
```

Use the SSH public key fallback only if Tailscale SSH is unavailable in your
tailnet.

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

Hosted VPS setup uses the root-managed `fased-gateway.service`, and that
service runs as the non-root `app` user. It should not ask for the `app`
password to run `sudo loginctl enable-linger app`.

`http://localhost:18789` is only the advanced SSH tunnel fallback. It works on
your local computer after you start the tunnel shown by onboarding and leave
that tunnel running. If SSH says `bind [127.0.0.1]:18789: Address already in
use`, Tailscale worked but your local port is busy. Stop the local Fased
gateway, or forward a different local port:

```bash
ssh -N -L 18790:127.0.0.1:18789 app@YOUR_VPS_TAILSCALE_NAME
```

Then open `http://localhost:18790/`. The raw gateway port stays closed to the
public internet.

`install.sh` runs onboarding by default. Use `./install.sh --no-onboard` only
when you want to install first and run onboarding later.

Hosted support boundary:

- **Hosted VPS hardening:** Ubuntu/Fedora/RHEL-family Linux with systemd.
- **Local/dev install:** Alpine, Arch, macOS, FreeBSD, WSL2, and common Linux
  desktops until their hosted hardening paths are validated separately.

## Update

For a local running install, open the Fased install directory first:

```bash
cd ~/fased
fased update status
fased update
```

On a hosted VPS, log in as the app user through Tailscale first:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

After hosted onboarding, SSH as `app` should open directly in `/home/app/fased`.
For hosted VPS setup, use `install.sh --hosting` so Fased can set the non-root
runtime, private Tailscale access, and closed public admin posture. Direct
global npm installs are for advanced local/dev or self-managed hosts.

The browser Control UI shows read-only update state under **Advanced > Debug >
Update Status**. Run the update from the CLI. Rerun `./install.sh` when you want
repair/reinstall behavior.

`fased update` uses the configured channel. **Stable is the default end-user
channel** and resolves to the latest stable release tag, not every commit on
`main`. Current development fixes on `main` are available only when you
intentionally track the developer channel:

| Command                                                 | What it gets              |
| ------------------------------------------------------- | ------------------------- |
| `git clone https://github.com/fased-ai/fased.git fased` | Latest `main` checkout    |
| `git pull --ff-only origin main`                        | Latest `main` checkout    |
| `fased update`                                          | Latest stable release tag |
| `fased update --channel dev`                            | Latest `main` checkout    |

```bash
fased update --channel dev
```

For development/testing from a repo checkout, the direct equivalent is:

```bash
git checkout main
git pull --ff-only origin main
./install.sh
```

On a hosted VPS, run that same development checkout flow as `app` from
`/home/app/fased` and use `./install.sh --hosting`. Use
`./install.sh --no-git-update` only when testing local changes that should not
be replaced by Git.

Telegram, WhatsApp, Discord, and Slack install as official add-ons only when
selected from **Agent > Channels**, onboarding, or `fased channels add`. Local
model servers and model weights are not bundled. See
[Core And Optional Components](./docs/install/components.md).

Fresh dashboard, Gateway, and Fased Network setup do not require the native
wallet signer. When you create the first signer-owned wallet, Fased downloads
the version-matched `fased-signerd` asset and verifies both its SHA-256 checksum
and GitHub release attestation. Normal users do not need Go. A source build is a
developer-only opt-in with `FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE=1`; Fased does
not silently replace a failed release verification with a local build.

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
- Agent workbench for tasks, tools, services, memory, files, and sessions
- Task history for workflows, webhooks, wallet actions, marketplace activity,
  mining events, ACP/subagent runs, and CLI/system activity
- Wallet UI with local signer integration, wallet roles, review, and spend caps
- SAT mining path with mining wallets, cycle history, and claim events
- Fased Network, Marketplace, bond surfaces, plugin SDK, bundled skills,
  extensions, mobile/macOS app code, and public docs

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
- Wallet pages own signing, caps, review, and broadcast. Workflows can request
  wallet actions while spend authority stays with wallet rules.
- Marketplace and Mining pages own their state-changing actions. Agent Tasks
  tracks and reviews those actions.
- Advanced/Debug/Nodes are admin surfaces for diagnostics and raw controls.

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
- **Graph**: a visual editor for the same workflow JSON.
- **Template**: a starter workflow such as wallet approval review, mining
  readiness/start gate, marketplace delivery/dispute, channel delivery review,
  media generation review, or service health check.
- **Program**: an Agent-scoped durable standing order that can propose work for
  review while grants still come from Tools, Skills, Wallets, and Mining rules.
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
- **Vault** wallets are for reserve, bond, and stronger trust roles.

Fased favors a self-hosted local signer and explicit wallet rules over hosted wallet
abstraction. External wallet providers can make sense for managed custody,
multi-tenant products, or compliance-heavy deployments, but Fased's default
model keeps keys and reviews under your setup and wallet rules.

Marketplace and Mining integration is intentionally task-ledger aware:

- Wallet reviews show spend evidence.
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

Fresh machines and hosted VPS installs should use the curl bootstrap because it
can install missing OS tools, Git, and Node. Use the explicit Local profile on
your own machine:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
```

Use the VPS Hosting profile only on the server that will run Fased all the time,
and use the [pre-execution verified tagged bootstrap](https://docs.fased.ai/install/vps#3-install-fased-and-connect-through-tailscale)
before executing root code.

The commands below are for contributors working from the source checkout. Do
not use plain `npm install` to install Fased from source.

Common source commands:

```bash
pnpm install
pnpm fased setup
pnpm ui:build
pnpm build
pnpm test:fast
pnpm --dir ui test
pnpm check:docs
```

Run the development gateway with reload:

```bash
pnpm gateway:watch
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
- `tools/`: repo tooling and admin helpers
- `vendor/`: vendored third-party code that must keep its own notices
- `config/`: runtime and channel/provider configuration helpers
- `test/`: test fixtures and integration helpers
- `token/`: SAT/token technical materials
- `Dockerfile`, `docker-compose.yml`, `docker-setup.sh`, and
  `setup-podman.sh`: Local Docker entrypoints plus an experimental Gateway-only
  Podman helper
- `deploy/`: sandbox/container assets and archived Fly/Render reference
  manifests; VPS Hosting uses `install.sh --hosting`, not those manifests

Root config files should stay at repository root unless the owning toolchain,
docs publisher, installer, and CI path are updated together.

## Legal, Attribution, And Risk

Fased is published under MIT with required third-party and copied-code notices.

Important:

- MIT permits modification and redistribution, but existing copyright and
  permission notices for copied material must be preserved.
- Third-party bundled code and assets are tracked in
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

Before using wallet, mining, Fased Network, trading, marketplace, or similar
economic features, read:

- [LICENSE](./LICENSE)
- [SECURITY.md](./SECURITY.md)
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
- [Disclaimer](./docs/legal/disclaimer.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [Plugin license policy](./docs/reference/plugin-license-policy.md)

Fased software is not financial, investment, tax, legal, or operational advice.
Wallets, crypto, mining, Fased Network, and marketplace workflows carry real
risk.
