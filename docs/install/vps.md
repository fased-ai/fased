---
summary: "VPS hosting hub for Fased (Oracle/Fly/Hetzner/GCP and general VPS guidance)"
read_when:
  - You want to run the Gateway in the cloud
  - You need a quick map of VPS/hosting guides
title: "VPS Hosting"
---

# VPS hosting

This hub links to the supported VPS/hosting guides and explains the current
hosted Fased posture at a high level.

## Local vs VPS security

- **Local install**
  - Best for: personal laptop, desktop, dev box, or WSL2.
  - Posture: lowest setup risk. Gateway stays on your machine; a home router
    usually does not expose it to the public internet. Tailscale is optional.
  - Access dependency: your local OS login.
- **VPS Hosting**
  - Best for: always-on cloud node.
  - Posture: higher exposure by default because a VPS is internet-reachable.
    Hosted setup closes public admin ports and requires Tailscale for private
    dashboard and SSH access.
  - Access dependency: your Tailscale account plus the VPS provider console for
    emergency recovery.

<Warning>
If you lose access to the Tailscale account used for a hosted VPS, normal
dashboard and SSH access can be lost. Recovery then depends on the VPS
provider's web console/rescue mode/rebuild tools. Keep your Tailscale account
recovery options and VPS provider console access working.
</Warning>

## VPS in 3 steps

For most users, the hosted path is:

1. On your own computer, install/sign into Tailscale and keep it online.
2. SSH into the fresh VPS using the login your VPS provider gives you.
3. Join the VPS to the same tailnet, install Fased, and choose the
   **Hosting** profile.

The hosted hardening profile is for Linux VPS systems with systemd. Auto-install
supports the common VPS families: Ubuntu, Debian, Kali, Fedora, CentOS,
AlmaLinux, Rocky Linux, CloudLinux, Oracle Linux, Amazon Linux, openSUSE, SLES,
Alpine, and Arch. Local macOS, FreeBSD, and WSL installs are supported for
running Fased, but macOS, FreeBSD, and native Windows are not hosted hardening
targets.

Hosted setup uses two machines:

- **Your own computer:** opens the dashboard and runs SSH checks.
- **The VPS:** runs Fased Agent.

Start on your own computer:

- **Windows**: use PowerShell or Windows Terminal. Install and sign into the
  Windows Tailscale app from [tailscale.com/download](https://tailscale.com/download).
  PowerShell can SSH into the Linux VPS.
- **macOS**: use Terminal and sign into the macOS Tailscale app.
- **Linux**: use Terminal and install/start Tailscale on that Linux machine.
- **WSL**: advanced only. Use PowerShell instead, or install/start Tailscale
  inside WSL too. Windows Tailscale does not automatically make WSL a Tailscale
  node.

Installing Tailscale from PowerShell is fine, but it still installs the Windows
Tailscale app/service. PowerShell uses that Windows Tailscale connection.

Other private-access systems are custom deployments. The standard hosted
installer does not configure or verify WireGuard, Headscale, ZeroTier, bastion
hosts, or manual SSH tunnels. If you replace Tailscale, you own dashboard
exposure, SSH policy, TLS, firewall rules, and recovery.

Do not paste the Linux install commands into PowerShell unless PowerShell is
already connected to the VPS over SSH. The commands below run **inside the VPS
SSH session**.

First SSH into the fresh VPS, often as `root`:

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

Then run this on the VPS:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh

curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --hosting
```

The Fased installer bootstraps the repository itself. A fresh VPS does not need
`git clone` first. It installs missing system tools, Node, `pnpm`, and Git when
the OS package manager supports auto-install.

If a very small Fedora/RHEL-family image does not have `curl`, install only the
downloader first, then rerun the same hosted command:

```bash
dnf install -y curl ca-certificates
```

On Debian/Ubuntu-family images without `curl`, use:

```bash
apt-get update
apt-get install -y curl ca-certificates
```

## Recommended VPS size

Fased can install on a 1 vCPU / 1 GB RAM VPS, but that is the minimum floor and
onboarding will be slow. For a smoother first install, use at least:

| VPS size            | Use it for              | Expectation                                                           |
| ------------------- | ----------------------- | --------------------------------------------------------------------- |
| 1 vCPU / 1 GB RAM   | Cheapest test node      | Works with swap, but install/onboarding can take a long time.         |
| 1-2 vCPU / 2 GB RAM | Recommended minimum     | Much better first install and normal hosted operation.                |
| 2 vCPU / 4 GB RAM   | Comfortable public node | Faster builds, smoother Control UI, and more room for channels/tasks. |

Use a 25 GB disk or larger. Keep the raw Gateway port private; use Tailscale for
operator access.

Current installers try a clean fast-forward update from Git before building. If
you already started from an older installer and it stopped before creating the
`app` runtime, update the bootstrap checkout once and rerun:

```bash
cd ~/fased
git pull --ff-only origin main
./install.sh --hosting
```

If you SSH into a fresh VPS as `root`, the installer creates a non-root `app`
user, prepares `/home/app/fased`, and re-runs the installer as `app`. That is
expected. After successful hosted onboarding, the temporary root checkout is
removed. Do not move the repo back to `/root`.

When `sudo tailscale up --ssh` prints a login URL in the SSH terminal, copy that
URL into your own device's browser. The VPS does not need a desktop browser.

Before SSH/firewall lock-down, setup pauses and asks you to test terminal access
from your own computer. That computer must have Tailscale installed, running,
and signed into the same tailnet as the VPS. Do not run the check commands
inside the VPS SSH session.

If your own computer says `tailscale: command not found`, install Tailscale on
your own computer first. Use the command for your own computer's OS, not the
VPS OS:

```bash
# Fedora local computer
sudo dnf install -y tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up

# Ubuntu / Debian / Kali local computer
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Arch local computer
sudo pacman -S tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
```

On Windows, install and sign into the Tailscale app, then use PowerShell for
the check. On macOS, install and sign into the Tailscale app, then use
Terminal. A separate VPN on your own computer can interfere with Tailscale DNS
or routing; if ping/SSH cannot reach the VPS, disconnect the other VPN or allow
Tailscale traffic and try again.

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

After onboarding completes, use both access paths:

- **Web dashboard:** open the printed `https://...ts.net/` URL in a browser on
  your own computer. That computer must be signed into the same Tailscale
  account. Save the gateway token in case the browser asks for it.
- **SSH terminal:** use regular SSH over Tailscale as `app` for CLI commands,
  updates, logs, and repairs. Run it from a computer signed into the same
  Tailscale network.

Then leave the original `root@...:~/fased` bootstrap shell. Normal operation
uses the `app` user over Tailscale from your own computer:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
cd /home/app/fased
fased health
fased status
fased dashboard
```

The `app` shell is a full Linux shell on the VPS and is configured to start in
`/home/app/fased`.

Use `fased health` as the single pass/fail check after hosting install. It
should start with `Gateway: online`. Use `fased health --verbose` only when you
want optional channel details. If health fails, inspect the service:

```bash
sudo systemctl status fased-gateway --no-pager
sudo journalctl -u fased-gateway -n 120 --no-pager
```

Root SSH is only for first bootstrap or emergency repair after the hosting
profile hardens SSH/UFW. Keep the raw Gateway port closed to the public
internet. `http://localhost:18789` is only the advanced SSH tunnel fallback: it
works on your local computer after you start the tunnel shown by onboarding and
leave that tunnel running.

<Note>
Small VPS installs size swap automatically when possible and run onboarding
with a larger Node heap. On hosts around 2 GB RAM, the first install can still
take several minutes while dependencies build and the gateway warms up.
</Note>

<Note>
Hosted VPS setup uses the root-managed `fased-gateway.service`, and that
service runs as the non-root `app` user. It should not ask for the `app`
password to run `sudo loginctl enable-linger app`. If an older checkout shows
that prompt or previously failed with `JavaScript heap out of memory`, update
the checkout and rerun `./install.sh --hosting`.
</Note>

## Update later

For normal updates, log in as `app` through Tailscale:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
cd /home/app/fased
fased update status
fased update
```

If the browser Control UI is reachable, **Update & Restart** uses the same
gateway update path. Rerun `./install.sh --hosting` only for repair/reinstall
behavior. `fased update` uses the configured channel; stable is the default
end-user channel and resolves to the latest stable release tag. It does not
pull every new commit from `main`.

Use `fased update --channel dev` only when intentionally tracking latest
development commits. For development/testing from the hosted repo checkout, the
direct app-user flow is:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
cd /home/app/fased
git checkout main
git pull --ff-only origin main
./install.sh --hosting
```

Do not use the root bootstrap checkout for normal updates after hosted
onboarding has completed.

<Note>
You do not need a Tailscale API key for the normal manual VPS flow. The
Tailscale CLI prints a URL you open from your own computer. Use a Tailscale auth
key only for non-interactive automation, cloud-init, Terraform, or scripted installs.
</Note>

<Warning>
Run this on the VPS, not from a laptop trying to configure another machine.
Hosting onboarding needs permission to apply host security and verify Tailscale
before it closes public management paths.
</Warning>

## Pick a provider

- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/month (Always Free, ARM; capacity/signup can be finicky)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **Other VPS providers**: a clean Ubuntu LTS box usually works fine if you follow
  the same hosting/onboarding and Tailscale guidance.

Fased docs only list hosted install methods backed by files in this repository,
for example `deploy/hosting/fly.toml`, `deploy/hosting/render.yaml`, Docker, or the repo installer. External
hosted presets are intentionally not listed because we cannot verify or maintain
them from this repo.

## How cloud setups work

- The **runtime and gateway run on the VPS** and own state + workspace.
- Root installs are bootstrapped into `/home/app/fased` and run as the `app`
  user. The root checkout is temporary bootstrap state.
- Treat the VPS as the source of truth and **back up** the state + workspace.
- Create or sign into **Tailscale before onboarding** that host. If you skip
  this, Hosting onboarding will stop to install/login Tailscale before it locks
  down SSH/firewall rules.
- Use `fased onboard --host-profile hosting` for the hosted path.
- Keep the gateway on loopback and access it via the private Tailscale HTTPS
  dashboard URL or SSH over the Tailscale network.
- Do **not** expose the raw gateway port publicly just to reach the dashboard or WS.
- If you bind to `lan`/`tailnet`, require `gateway.auth.token` or `gateway.auth.password`.

Remote access: [Gateway remote](/gateway/remote)  
Platforms hub: [Platforms](/platforms)

## Shared company agent on a VPS

This is a valid setup when the users are in one trust boundary (for example one
company team), and the runtime is business-only.

- Keep it on a dedicated runtime (VPS/VM/container + dedicated OS user/accounts).
- Do not sign that runtime into personal Apple/Google accounts or personal browser/password-manager profiles.
- If users are adversarial to each other, split by gateway/host/OS user.

Security model details: [Security](/gateway/security)

## Using nodes with a VPS

You can keep the Gateway in the cloud and pair **nodes** on your local devices
(Mac/iOS/Android/headless). Nodes provide local screen/camera/canvas and `system.run`
capabilities while the Gateway stays in the cloud.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
