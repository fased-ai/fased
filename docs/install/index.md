---
summary: "Install Fased with the repo-backed installer, then finish setup in the Control UI."
read_when:
  - You need an install method other than the Getting Started quickstart
  - You want to deploy to a local machine, container, or private host
  - You need to update, migrate, or uninstall
title: "Install"
---

# Install

Already followed [Getting Started](/start/getting-started)? You can usually
continue there. This page is for install methods, platform notes, hosting
profiles, and maintenance.

```mermaid
flowchart LR
  choose["choose install path"] --> repo["repo installer"]
  choose --> container["container path"]
  choose --> host["hosted runtime"]
  repo --> onboard["onboarding"]
  container --> verify["verify gateway"]
  host --> private["private access first"]
  private --> onboard
  onboard --> ui["Control UI"]
  ui --> models["Models"]
  ui --> chat["first chat"]

  classDef root fill:#120605,stroke:#ff5a36,color:#ffffff;
  classDef run fill:#071018,stroke:#12cfff,color:#ffffff;
  classDef host fill:#20120a,stroke:#ffb020,color:#ffffff;
  class choose,repo root;
  class onboard,ui,models,chat,verify run;
  class container,host,private host;
```

## System requirements

- [Node 24 recommended, or Node 22.14+ with `node:sqlite`](/install/node)
- macOS, Linux, or Windows through WSL2
- `pnpm` only when building from source

<Note>
Windows has two different paths:

- **Local install on your Windows PC:** use
  [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) and run Fased
  inside Ubuntu.
- **Managing a hosted VPS from Windows:** use PowerShell or Windows Terminal
  with the Windows Tailscale app online. Do not use WSL for hosted SSH checks
  unless Tailscale is also installed and logged in inside WSL.
  </Note>

## Pick local or VPS hosting

These are different setup paths. Choose **Local** for a laptop, desktop, dev
box, or WSL2. Choose **VPS Hosting** only on the server that will run Fased
all the time.

| Path          | Best for                                | Security posture                                                                                                                                                | Access dependency                                                            |
| ------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Local install | Personal laptop, desktop, dev box, WSL2 | Lowest setup risk. Gateway stays on your machine; a home router usually does not expose it to the public internet. Tailscale is optional.                       | Your local OS login.                                                         |
| VPS Hosting   | Always-on cloud node                    | Higher exposure by default because a VPS is internet-reachable. Hosted setup closes public admin ports and requires Tailscale for private dashboard/SSH access. | Your Tailscale account plus the VPS provider console for emergency recovery. |

<Warning>
If you lose access to the Tailscale account used for a hosted VPS, normal
dashboard and SSH access can be lost. Recovery then depends on the VPS
provider's web console/rescue mode/rebuild tools. Keep your Tailscale account
recovery options and VPS provider console access working.
</Warning>

<Tabs>
  <Tab title="Local install">
    Use this on your own machine:

    ```bash
    git clone https://github.com/fased-ai/fased.git fased
    cd fased
    ./install.sh
    ```

    Local setup keeps the Gateway on this machine and does not apply VPS SSH or
    firewall hardening. Tailscale is optional for Local.

    After local setup:

    1. Keep the dashboard tab that opens, or run `fased dashboard`.
    2. Go to **Agent > Models** and connect a model provider.
    3. Open **Chat** and send a test message.

    Successful install output is intentionally short. If a step fails, the
    installer prints the full log path under `~/.fased/logs/`.

  </Tab>
  <Tab title="VPS Hosting install">
    Use this on a clean Linux VPS. A 1 vCPU / 1 GB RAM VPS can work as a
    minimum test node, but expect slow install/onboarding. For a smoother public
    node, use at least 2 GB RAM; 2 vCPU / 4 GB RAM is more comfortable.

    Hosted setup uses two machines:

    - **Your own computer:** opens the dashboard and runs SSH checks.
    - **The VPS:** runs Fased Agent.

    Start on your own computer:

    | Your computer | Use this terminal | Tailscale requirement |
    | --- | --- | --- |
    | Windows | PowerShell or Windows Terminal | Install/sign into the Windows Tailscale app from [tailscale.com/download](https://tailscale.com/download). PowerShell can SSH into the Linux VPS. |
    | macOS | Terminal | Install/sign into the macOS Tailscale app. |
    | Linux | Terminal | Install/start Tailscale on that Linux machine. |
    | WSL | Advanced only | Either use PowerShell instead, or install/start Tailscale inside WSL too. Windows Tailscale does not automatically make WSL a Tailscale node. |

    Installing Tailscale from PowerShell is fine, but it still installs the
    Windows Tailscale app/service. PowerShell uses that Windows Tailscale
    connection.

    Other private-access systems are custom deployments. The standard hosted
    installer does not configure or verify WireGuard, Headscale, ZeroTier,
    bastion hosts, or manual SSH tunnels. If you replace Tailscale, you own
    dashboard exposure, SSH policy, TLS, firewall rules, and recovery.

    Do not paste the Linux install commands into PowerShell unless PowerShell is
    already connected to the VPS over SSH. The commands below run **inside the
    VPS SSH session**.

    First SSH into the fresh VPS using the login your VPS provider gives you,
    often `root@YOUR_PUBLIC_VPS_IP`:

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

    Current installers try a clean fast-forward update from Git before building.
    If you already started from an older installer and it stopped, run
    `git pull --ff-only origin main` once in the checkout and rerun
    `./install.sh --hosting`.

    If you start as `root`, the installer creates a non-root `app` user,
    prepares `/home/app/fased`, re-runs itself there, and removes the temporary
    root checkout after successful hosted onboarding.

    The VPS must also join the same Tailscale tailnet before setup can finish.
    The hosted profile keeps the raw Gateway port closed.

    Before SSH/firewall lock-down, setup pauses and asks you to test terminal
    access from your own computer:

    ```bash
    tailscale ping YOUR_VPS_TAILSCALE_NAME
    ssh app@YOUR_VPS_TAILSCALE_NAME
    ```

    If `tailscale ping` says `no matching peer`, your computer and the VPS are
    not in the same Tailscale network. Sign your computer into the same
    Tailscale account, or re-authenticate Tailscale on the VPS, then rerun the
    check.

    Only confirm after that command connects through Tailscale and opens
    `/home/app/fased`. If it does not connect, setup stops before disabling root
    or password SSH.
    If the original VPS login was password-only and no SSH public key is
    available, setup stops before hardening; add your public key and rerun.

    At the end, onboarding prints two access paths:

    - **Web dashboard:** open the printed `https://...ts.net/` URL in a browser
      on your own computer. That computer must be signed into the same
      Tailscale account. Save the gateway token in case the browser asks for it.
    - **SSH terminal:** use regular SSH over Tailscale as `app` for CLI commands,
      updates, logs, and repairs. Run it from a computer signed into the same
      Tailscale network.

    After hosted onboarding completes, leave the original root bootstrap shell
    and reconnect over Tailscale as the `app` user from your own computer:

    ```bash
    ssh app@YOUR_VPS_TAILSCALE_NAME
    fased status
    fased dashboard
    ```

    The `app` shell is a full Linux shell on the VPS and is configured to start
    in `/home/app/fased`.

    Root SSH is for initial bootstrap or emergency repair, not normal
    operation. `http://localhost:18789` is only the advanced SSH tunnel fallback:
    it works on your local computer after you start the tunnel shown by
    onboarding and leave it running.

  </Tab>
</Tabs>

The installer is repo-backed from `fased-ai/fased`.

<Note>
Do not use normal local `fased onboard` on a laptop to configure a remote VPS.
Run the hosted install **on the VPS itself**. If you choose Hosting from a
session that cannot apply host security, onboarding stops with “Hosted setup
unavailable” instead of creating an incomplete hosted setup.
</Note>

## Basic installer command

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
```

The installer:

- checks the host environment
- checks Node and installs supported Linux dependencies when needed
- installs the `fased` CLI
- runs onboarding by default
- opens the path to the browser Control UI

To install the CLI/runtime without onboarding:

```bash
./install.sh --no-onboard
```

For flags and automation details, see [Installer Reference](/install/installer).

## Updating after install

Use `fased update` for normal updates. On a hosted VPS, log in as the `app`
user through Tailscale first:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

The browser Control UI can also run **Update & Restart** when the gateway is
healthy. Rerun `./install.sh` for repair/reinstall behavior; the current
installer fast-forwards a clean Git checkout before building unless
`--no-git-update` is set.

## What onboarding does

Onboarding creates the baseline runtime: state directory, config, workspace,
Gateway service, dashboard access, and selected hosting posture.

It does not configure every Agent capability. After install, continue in the
Control UI from the selected Agent:

1. **Models**
2. **Chat**
3. **Channels**
4. **Services**
5. **Skills / Tools**
6. **Memory**
7. **Tasks**
8. Wallets, Mining, and Fased Network only when you intentionally enable them

<Note>
Pre-launch installs keep Satcoin runtime IDs empty. After official Satcoin
mainnet proof is published, use **Mining > Sync** to verify the signed manifest
and write `config/sat-runtime.env`.
</Note>

## VPS hosting posture

For a hosted or VPS runtime:

1. start from a clean Linux VPS
2. create/sign into Tailscale and join the VPS to your tailnet with `sudo tailscale up --ssh`
3. run `./install.sh --hosting` or choose **Hosting** during onboarding
4. after onboarding, reconnect as `app` over the Tailscale network
5. avoid exposing the raw Gateway port publicly

Normal manual setup does **not** need a Tailscale API key. If the VPS is not
logged in, Tailscale prints a login URL in the SSH terminal. Open that URL in
your local computer's browser, then return to the SSH session. Use
`--ts-authkey` only for non-interactive provisioning.

If Tailscale is missing or not logged in, Hosting onboarding tries to install or
start it. If it cannot get a valid tailnet IP, it refuses to apply the SSH/UFW
lockdown because you could lose remote access.

Use [VPS hosting](/install/vps), [Hetzner](/install/hetzner), or
[GCP](/install/gcp) for provider-specific commands.

## Install method map

| Method                   | Status                    | Use when                                                              |
| ------------------------ | ------------------------- | --------------------------------------------------------------------- |
| Repo-backed `install.sh` | Recommended public path   | macOS, Linux, WSL2, local laptop, or VPS runtime                      |
| Source checkout          | Contributor path          | You want to build, test, or patch the repo directly                   |
| Hosted/VPS profile       | Supported                 | You want an always-on Linux host with private access first            |
| Docker                   | Supported optional path   | You want a containerized Gateway or sandbox validation                |
| Podman                   | Supported container path  | You want rootless containers on Linux                                 |
| Nix                      | Advanced/declarative path | You already manage runtimes with Nix/Home Manager                     |
| Bun                      | Experimental dev path     | You want local TypeScript iteration; use Node for the Gateway runtime |
| Remote client mode       | Supported client mode     | This machine should connect to an existing Gateway                    |
| Task worker install      | Supported after setup     | You want separate task workers once a Gateway/runtime already exists  |

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Containerized Gateway and sandbox reference.
  </Card>
  <Card title="Podman" href="/install/podman" icon="container">
    Rootless container path for Linux.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Declarative install path for Nix users.
  </Card>
  <Card title="Node.js" href="/install/node" icon="terminal">
    Runtime version and PATH troubleshooting.
  </Card>
</CardGroup>

<Note>
Public npm/pnpm global installation is not the normal public setup path yet.
Use the repo-backed installer until a package release is published and
documented.
</Note>

## Validate install

```bash
fased doctor
fased status
fased dashboard
```

Good result:

- `fased doctor` reports no blocking setup errors
- `fased status` shows the Gateway target you expect
- `fased dashboard` opens an auth-ready Control UI link

## After install

Use this order for a new runtime:

1. verify runtime health
2. confirm private operator access
3. configure model access
4. send a first chat message
5. add channels and services as needed
6. define wallet and signer posture before using wallet-related features
7. enable Mining or Fased Network only after the base runtime is stable

Successful installation means the runtime exists. It does not replace the
setup checks for channels, services, wallets, mining, or network roles.

## Troubleshooting: `fased` not found

<Accordion title="PATH diagnosis and fix">
  Quick diagnosis:

```bash
node -v
ls -l "$HOME/.local/bin/fased"
echo "$PATH"
```

The repo-backed installer writes the launcher to
`${FASED_CLI_BIN_DIR:-$HOME/.local/bin}/fased`. If `$HOME/.local/bin` is not on
your PATH, your shell cannot find `fased`.

Fix by adding it to `~/.zshrc` or `~/.bashrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then open a new terminal, or run `rehash` in zsh / `hash -r` in bash.
</Accordion>

## Update, migrate, uninstall

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Refresh the repo-backed runtime.
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    Move state and workspace to a new machine.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    Remove services, CLI, and state.
  </Card>
</CardGroup>
