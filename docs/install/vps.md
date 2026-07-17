---
summary: "Maintained non-Docker VPS hosting for Fased"
read_when:
  - You want to run the Gateway in the cloud
  - You need a quick map of VPS/hosting guides
title: "VPS Hosting"
---

# VPS hosting

This hub links to the supported VPS/hosting guides and explains the current
hosted Fased posture at a high level.

<Warning>
The supported VPS path is the host-managed `install.sh --hosting` profile. The
full Docker Gateway is Local only; there is no `--hosting-docker` mode. Fly.io
and Render container manifests are archived and unsupported.
</Warning>

## Local vs VPS security

- **Local install**
  - Best for: your own computer: macOS Terminal, Windows with WSL2 Ubuntu,
    Linux desktop, or dev box.
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

1. On your own computer, turn off other VPNs, install/sign into Tailscale, and
   keep it online.
2. SSH into the fresh VPS using the login your VPS provider gives you.
3. Run the Fased hosted installer; it joins the VPS to Tailscale and guides the
   **Hosting** profile.

Ubuntu LTS is the recommended VPS OS for a first hosted setup. Debian is close
to the same path. The honest hosted support line is:

- **Hosted VPS hardening:** Ubuntu/Fedora/RHEL-family Linux with systemd.
- **Local/dev install:** Alpine, Arch, macOS, FreeBSD, WSL2, and common Linux
  desktops until their hosted hardening paths are validated separately.

Hosted setup uses two machines:

- **Your own computer:** opens the dashboard and runs SSH checks.
- **The VPS:** runs Fased Agent.

## 1. Connect your local PC to Tailscale

Your own computer must join the same Tailscale account/tailnet as the VPS. That
is the computer where you will open the dashboard and run SSH checks.
Before you start the remote VPS installer, shut down local VPNs such as Mullvad,
Proton VPN, NordVPN, corporate VPN clients, and browser/device VPN apps. For
Fased hosted setup, do not run another VPN beside Tailscale while verifying
dashboard and SSH access. Other VPNs can override DNS, firewall rules, or the
`100.64.0.0/10` address range that Tailscale uses.

If you need Mullvad-style privacy while using Tailscale, use Tailscale's paid
Mullvad VPN add-on instead of running the Mullvad app beside Tailscale. That
add-on supports Mullvad only; it does not cover Proton, NordVPN, corporate VPN
clients, or other VPN providers. See
[Other VPNs and Mullvad](/gateway/tailscale#other-vpns-and-mullvad).

<Tabs>
  <Tab title="Windows">
    Install the Tailscale app from
    [tailscale.com/download](https://tailscale.com/download), sign in, and use
    PowerShell or Windows Terminal for checks. Disconnect other local VPNs
    first.

    PowerShell uses the Windows Tailscale app/service. If you use WSL instead,
    install and sign into Tailscale inside WSL too.

  </Tab>
  <Tab title="macOS">
    Install the Tailscale app from
    [tailscale.com/download](https://tailscale.com/download) or the App Store,
    sign in, and use Terminal for checks.
  </Tab>
  <Tab title="Ubuntu">
    Use this for Ubuntu, Debian, or Kali local computers:

    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo systemctl enable --now tailscaled
    sudo tailscale up
    tailscale status
    tailscale ip -4
    ```

  </Tab>
  <Tab title="Fedora">
    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo systemctl enable --now tailscaled
    sudo tailscale up
    tailscale status
    tailscale ip -4
    ```
  </Tab>
  <Tab title="Arch">
    ```bash
    sudo pacman -S tailscale
    sudo systemctl enable --now tailscaled
    sudo tailscale up
    tailscale status
    tailscale ip -4
    ```
  </Tab>
</Tabs>

Do not continue until `tailscale status` shows your local computer online and
`tailscale ip -4` prints a `100.x.x.x` address. If status says it failed to
connect to local `tailscaled`, start the daemon with
`sudo systemctl enable --now tailscaled` on Linux, then rerun
`sudo tailscale up` and sign in.

Other private-access systems are custom deployments. The standard hosted
installer does not configure or verify WireGuard, Headscale, ZeroTier, bastion
hosts, or manual SSH tunnels. If you replace Tailscale, you own dashboard
exposure, SSH policy, TLS, firewall rules, and recovery.

Do not paste the Linux VPS install commands into PowerShell unless PowerShell is
already connected to the VPS over SSH. The commands below run **inside the VPS
SSH session**.

## 2. SSH into the VPS

First SSH into the fresh VPS, often as `root`:

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

## 3. Install Fased and connect through Tailscale

For the strongest bootstrap boundary, install the GitHub CLI from your VPS
distribution's trusted package source, confirm `gh version`, then verify the
release asset **before** running it:

```bash
RELEASE=vX.Y.Z # replace with the stable release you intend to install
BOOTSTRAP_DIR="$(mktemp -d)"
chmod 0700 "$BOOTSTRAP_DIR"
curl -fsSLo "$BOOTSTRAP_DIR/install.sh" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/install.sh"
curl -fsSLo "$BOOTSTRAP_DIR/install.sh.attestation.json" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/install.sh.attestation.json"
GH_PROMPT_DISABLED=1 gh attestation verify "$BOOTSTRAP_DIR/install.sh" \
  --repo fased-ai/fased \
  --bundle "$BOOTSTRAP_DIR/install.sh.attestation.json" \
  --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
  --source-ref "refs/tags/${RELEASE}" \
  --deny-self-hosted-runners
chmod 0500 "$BOOTSTRAP_DIR/install.sh"
bash "$BOOTSTRAP_DIR/install.sh" --hosting --release "$RELEASE"
rm -rf "$BOOTSTRAP_DIR"
```

This checks the bootstrap digest, the `fased-ai/fased` repository identity, the
exact tagged source ref, the exact release workflow, and GitHub-hosted runner
provenance. The attestation bundle is public; this check does not require write
access to the repository. Stop if either download or verification fails.

The shorter tagged raw command used elsewhere in the docs is a convenience
path. It relies on HTTPS, GitHub, and repository/tag integrity for the first
shell process; only after it starts can it attest the downloaded Hosting
bundle. Use the pre-execution verification block above when the initial root
bootstrap is part of your threat model.

After the verified bootstrap begins, the root phase downloads the matching
architecture-specific hosted app bundle, verifies its checksum and
GitHub/Sigstore attestation for that exact tag, stores it under a root-owned
immutable digest path, and only then installs privileged assets. `--release
latest` is accepted for interactive convenience, but an explicit stable tag is
easier to audit and reproduce.

The hosted installer installs/starts Tailscale when needed. When Fased prints a
Tailscale login URL, open that URL in your local PC browser, sign in, and
approve. After that, the VPS is added to your tailnet automatically.

<Accordion title="If you already ran Tailscale manually and it is stuck">
Avoid running `tailscale up --ssh` manually before Fased. On some VPS images,
the Tailscale UI can show the VPS as approved while the manual CLI command
keeps waiting. If you already ran it and it is stuck, open a second provider SSH
session and verify that Tailscale is actually online:

```bash
tailscale status
tailscale ip -4
```

If those commands show the VPS and a `100.x.x.x` tailnet IP, press `Ctrl+C` in
the stuck `tailscale up --ssh` terminal and continue with the Fased hosted
install command. If they do not show a tailnet IP, run `tailscale logout`,
restart `tailscaled`, and run the Fased hosted install command again.
</Accordion>

The Fased installer bootstraps the repository itself. A fresh VPS does not need
`git clone` first. It installs missing system tools, Node, and Git when the OS
package manager supports auto-install. Hosted installs may use the published
runtime package internally, so the slow source build is skipped on normal fresh
VPS installs.

If a very small VPS image does not have `curl`, install only the downloader for
that VPS OS, then rerun the hosted command above.

<Accordion title="Minimal VPS image: install curl first">
  <Tabs>
    <Tab title="Ubuntu">
      Use this for Ubuntu, Debian, or Kali VPS images:

      ```bash
      apt-get update
      apt-get install -y curl ca-certificates
      ```

    </Tab>
    <Tab title="Fedora">
      ```bash
      dnf install -y curl ca-certificates
      ```
    </Tab>
    <Tab title="RHEL">
      Use this for RHEL-family VPS images:

      ```bash
      dnf install -y curl ca-certificates
      ```

    </Tab>
    <Tab title="Arch">
      ```bash
      pacman -Sy --needed --noconfirm curl ca-certificates
      ```
    </Tab>
    <Tab title="Alpine">
      ```bash
      apk add --no-cache curl ca-certificates
      ```
    </Tab>

  </Tabs>
</Accordion>

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

If an older install stopped before creating the `app` runtime, do not run its
checkout with sudo. Return to the provider root console and repeat the
[pre-execution verified bootstrap](#3-install-fased-and-connect-through-tailscale)
for the exact tagged release. Use `--repair-hosting` instead of `--hosting` only
when an existing Hosting installation is being repaired. Do not recover a root
installation by piping an unverified script directly into a shell.

If you SSH into a fresh VPS as `root`, the installer creates a non-root `app`
user, prepares `/home/app/fased`, and re-runs the installer as `app`. That is
expected. After successful hosted onboarding, the temporary root checkout is
removed. Do not move the repo back to `/root`.

When the Fased installer prints a Tailscale login URL in the SSH terminal, copy
that URL into your own device's browser. The VPS does not need a desktop
browser.

Before SSH/firewall lock-down, setup pauses and asks you to test terminal access
from your own computer. That computer must have Tailscale installed, running,
and signed into the same tailnet as the VPS. Do not run the check commands
inside the VPS SSH session.

<Accordion title="Tailscale check, VPN, and MagicDNS troubleshooting">
If your own computer says `tailscale: command not found`, return to step 1 and
install Tailscale on your local PC first. If `tailscale status` says it cannot
connect to local `tailscaled`, the local Tailscale service is not running; start
it and sign in before continuing. A separate VPN on your own computer can
interfere with Tailscale DNS or routing. Turn the other VPN off for hosted
setup. If it must stay on later, use the `100.x.x.x` Tailscale IP instead of
the hostname and configure split tunneling in that VPN.

If the VPN you want is Mullvad, prefer Tailscale's paid Mullvad VPN add-on
instead of running the Mullvad desktop/mobile VPN app beside Tailscale. The
add-on is enabled in the Tailscale admin console, then granted to devices; it
supports Mullvad only. See
[Other VPNs and Mullvad](/gateway/tailscale#other-vpns-and-mullvad).

If `tailscale ping 100.x.x.x` works but
`ssh app@YOUR_VPS_TAILSCALE_NAME` fails with a hostname/DNS error, Tailscale is
connected but MagicDNS is being blocked or overridden, often by the other VPN.
Turn the other VPN off, fix its DNS split-tunnel rules, or use the Tailscale IP
directly:

```bash
tailscale status
tailscale ping YOUR_VPS_TAILSCALE_NAME
tailscale ping 100.x.x.x
ssh app@YOUR_VPS_TAILSCALE_NAME
ssh app@100.x.x.x
```

If `tailscale ping` says `no matching peer`, your computer and the VPS are not
in the same Tailscale network. Sign your computer into the same Tailscale
account, or re-authenticate Tailscale on the VPS, then rerun the check.
</Accordion>

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
fased health
fased status
fased dashboard
```

The `app` shell is a full Linux shell on the VPS and is configured to start in
`/home/app/fased`.

Use `fased health` as the single pass/fail check after hosting install. It
should start with `Gateway: online`. Use `fased health --verbose` only when you
want optional channel details. The `app` account intentionally has no `sudo`
access to the Gateway, signer, or root updater. It can run application-level
diagnostics:

```bash
fased gateway status
fased wallet signer doctor --json
```

If root-owned service state or journals are required, use the VPS provider's
authenticated console or an authorized host-administrator session, not an
`app` sudo rule:

```bash
systemctl status fased-gateway fased-signerd --no-pager
journalctl -u fased-gateway -u fased-signerd -n 120 --no-pager
```

If the hosted dashboard or SSH works immediately after setup but fails after you
turn another VPN back on, the VPS is usually still fine. Turn the other VPN off
and test `tailscale status`, `tailscale ping`, and the `100.x.x.x` Tailscale IP
from your own computer. For Mullvad, use Tailscale's paid Mullvad VPN
add-on/Mullvad exit nodes instead of running the Mullvad VPN app beside
Tailscale. Other VPN providers still need their own split-tunnel or firewall
workaround.

Root SSH is only for first bootstrap or emergency repair after the hosting
profile hardens SSH/UFW. Keep the raw Gateway port closed to the public
internet. `http://localhost:18789` is only the advanced SSH tunnel fallback: it
works on your local computer after you start the tunnel shown by onboarding and
leave that tunnel running. If SSH says
`bind [127.0.0.1]:18789: Address already in use`, Tailscale worked but your
local port is busy. Stop the local Fased gateway, or forward a different local
port:

```bash
ssh -N -L 18790:127.0.0.1:18789 app@YOUR_VPS_TAILSCALE_NAME
```

Then open `http://localhost:18790/`.

<Note>
Small VPS installs size swap automatically when possible and run onboarding
with a larger Node heap. On hosts around 2 GB RAM, the first install can still
take a little time while the npm package installs and the gateway warms up, but
the hosted default no longer builds the full source tree.
</Note>

<Note>
Hosted VPS setup uses the root-managed `fased-gateway.service`, and that
service runs as the non-root `app` user. It should not ask for the `app`
password to run `sudo loginctl enable-linger app`. If an older checkout shows
that prompt or previously failed with `JavaScript heap out of memory`, rerun
the exact tagged, attested command from the provider root console.
</Note>

<Note>
Tailscale Serve terminates HTTPS in front of the loopback-only Gateway. Hosted
setup trusts only the loopback proxy ranges and keeps Control UI device/session
identity enabled. It does not enable the plain-HTTP `allowInsecureAuth`
compatibility flag.
</Note>

## Update later

For normal updates, log in as `app` through Tailscale:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

After hosted onboarding, SSH as `app` should open directly in `/home/app/fased`.
If it does not, fix the hosted login/shell setup before updating.

The browser Control UI reports version and update availability under
**Advanced > Debug > Update Status**. Run the actual update from the CLI.
For repair/reinstall behavior, rerun the exact tagged command from the provider
root console. Never run `/home/app/fased/install.sh` with sudo or as root.
`fased update` uses the configured channel; stable is the default end-user
channel and resolves to the latest stable release tag. It does not pull every
new commit from `main`.

If a legacy hosted updater reports success but `fased --version` does not
change, use the one-time non-destructive repair in
[Updating](/install/updating#legacy-hosted-updater-repair). It refreshes the
managed runtime and root Gateway service without rerunning onboarding or
resetting `/home/app/.fased` state.

Do not use a direct global npm install as the normal VPS hosting path. The
hosted installer is recommended because it sets the `app` runtime, Tailscale
access, and closed public admin posture. Manual npm installs are for advanced
local/dev or self-managed hosts.

Use `fased update --channel dev` only when intentionally tracking the
development channel:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update --channel dev
```

Do not run `./install.sh --hosting` from the `app` shell or grant `app` sudo.
The bootstrap installer is a provider-console host-administrator operation;
normal `app` updates use the verified managed Gateway and root signer updater.
There is no app-visible root bootstrap socket or general maintenance daemon.

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

- **Oracle Cloud**: [Oracle](/platforms/oracle)
- **Hetzner**: [Hetzner](/install/hetzner) — maintained non-Docker Hosting installer
- **GCP (Compute Engine)**: [GCP](/install/gcp) — maintained non-Docker Hosting installer
- **DigitalOcean**: [DigitalOcean](/platforms/digitalocean)
- **Other VPS providers**: a clean Ubuntu LTS box usually works fine if you follow
  the same hosting/onboarding and Tailscale guidance.

Use the same `install.sh --hosting` command on each supported provider. Provider
guides cover VM creation and access; they do not replace the Fased installer.

Fly.io and Render are not supported hosting targets. Their repo manifests and
docs remain only as [Fly migration guidance](/install/fly) and
[Render migration guidance](/install/render) for existing users.

## How cloud setups work

- The **runtime and gateway run on the VPS** and own state + workspace.
- Root installs are bootstrapped into `/home/app/fased` and run as the `app`
  user. The root checkout is temporary bootstrap state.
- Treat the VPS as the source of truth and **back up** the state + workspace.
- Let hosted onboarding install/start/login Tailscale when needed before it
  locks down SSH/firewall rules.
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
