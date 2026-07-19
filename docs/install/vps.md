---
summary: "Install Fased on an always-on VPS with private Tailscale access."
read_when:
  - You want to run Fased on a VPS
  - You need Hosting access or recovery guidance
title: "VPS Hosting"
---

# VPS Hosting

Use VPS Hosting when Fased must stay online. Ubuntu LTS is the recommended
first server. The maintained path is host-managed `install.sh --hosting`; the
full Docker Gateway is Local only.

## Install in 3 steps

### 1. Prepare your own computer

Install [Tailscale](https://tailscale.com/download), sign in, and keep it
online. This is the computer where you will open the dashboard and test private
SSH access.

<Accordion title="Linux Tailscale commands">
  On Ubuntu, Debian, or Kali:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up
tailscale status
tailscale ip -4
```

Windows and macOS users normally use the native Tailscale app. Turn off
another VPN while testing because it may override Tailscale DNS or routing.
</Accordion>

### 2. Connect to the VPS

Use the root login supplied by your VPS provider:

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

The remaining commands run **inside this VPS SSH session**.

### 3. Verify and run the Hosting bootstrap

Install a current [GitHub CLI](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)
with `gh attestation verify` on the VPS, then run this block. The exact release
bootstrap is downloaded as data, verified against the Fased release workflow,
and only then executed:

```bash
(
set -euo pipefail
RELEASE=v0.1.65
BOOTSTRAP_DIR="$(mktemp -d)"
trap 'rm -rf "$BOOTSTRAP_DIR"' EXIT

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
)
```

The installer automatically:

- installs the exact stable Fased tag named in `RELEASE`;
- verifies the tagged release manifest and architecture-specific Hosting
  bundle with GitHub attestations before privileged Fased installation;
- installs or starts Tailscale on the VPS through signed package repositories;
- creates the non-root `app` runtime and root-managed service;
- keeps the Gateway private and guides the SSH/firewall access check.

When it prints a Tailscale login URL, open that URL in your own computer's
browser. You do not need to install Tailscale manually on the VPS first.

<Warning>
Do not run the Hosting command on your laptop or in an unconnected PowerShell
window. Run it only in the fresh VPS provider root shell. Keep provider-console
access until Tailscale SSH and the dashboard work.
</Warning>

## Confirm private access

Before the installer closes public administrative access, it asks you to test
from your own computer:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
```

Confirm only when that reaches `/home/app/fased`. If normal SSH is unavailable,
the wizard may offer Tailscale SSH:

```bash
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
```

After setup, leave the root bootstrap shell and use the `app` account:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased health
fased dashboard
```

Open the printed `https://...ts.net/` dashboard URL on a device signed into the
same Tailscale account. Save the Gateway recovery token.

## Advanced verification and exact release selection

<Accordion title="Manual pre-execution attestation verification">
  The normal procedure above already performs pre-execution verification.
  Advanced operators may replace `RELEASE` with another exact stable tag,
  inspect the downloaded script before the final `bash`, or retain the
  attestation JSON with their installation records. Never replace the exact
  tag with `main`, `latest`, or another moving reference.

For emergency repair, use the same verified block and change only the final
invocation to `--repair-hosting --release "$RELEASE"`. A repair never accepts
streamed shell input.
</Accordion>

## Updates

Run normal updates as `app` through Tailscale:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

Do not run `/home/app/fased/install.sh` with `sudo`. A successful fresh install
does not need `--repair-hosting`.

<AccordionGroup>
  <Accordion title="Emergency Hosting repair">
    Use repair only if the root-managed updater or service is broken. From the
    VPS provider root console, download and attest an exact tagged `install.sh`
    with the verified procedure above, then replace its final command with:

    ```bash
    bash "$BOOTSTRAP_DIR/install.sh" --repair-hosting --release "$RELEASE"
    ```

    Never pipe `--repair-hosting` from moving `main`, and never grant the `app`
    user sudo access.

  </Accordion>

  <Accordion title="Minimal VPS image: install curl first">
    Ubuntu or Debian:

    ```bash
    apt-get update
    apt-get install -y curl ca-certificates
    ```

    Fedora or RHEL-family:

    ```bash
    dnf install -y curl ca-certificates
    ```

  </Accordion>

  <Accordion title="Tailscale, VPN, and MagicDNS troubleshooting">
    On your own computer, confirm `tailscale status` shows it online. Turn off
    other VPN software during setup. Test both the Tailscale hostname and the
    `100.x.x.x` address:

    ```bash
    tailscale status
    tailscale ping YOUR_VPS_TAILSCALE_NAME
    ssh app@YOUR_VPS_TAILSCALE_NAME
    ssh app@100.x.x.x
    ```

    `no matching peer` usually means the computer and VPS are signed into
    different tailnets. A hostname-only failure usually means another VPN or
    DNS configuration is overriding MagicDNS.

  </Accordion>

  <Accordion title="If a manual tailscale up command is stuck">
    Open a second provider SSH session and run:

    ```bash
    tailscale status
    tailscale ip -4
    ```

    If the VPS already has a `100.x.x.x` address, stop the stuck command with
    `Ctrl+C` and rerun the Fased Hosting command. Otherwise run
    `tailscale logout`, restart `tailscaled`, and let Fased guide login again.

  </Accordion>

  <Accordion title="Security and recovery boundary">
    VPS Hosting keeps the raw Gateway port on loopback, serves the dashboard
    privately through Tailscale, and runs Fased as non-root `app`. Keep both
    Tailscale account recovery and the VPS provider console available. Other
    private networks are custom deployments and require you to manage firewall,
    TLS, SSH, and recovery policy.
  </Accordion>
</AccordionGroup>

## Capacity and supported hosts

| Size              | Suitable for                                     |
| ----------------- | ------------------------------------------------ |
| 1 vCPU / 1 GB RAM | Minimum test server; setup may be slow           |
| 2 GB RAM          | Practical small always-on agent                  |
| 2 vCPU / 4 GB RAM | More comfortable for tools and multiple services |

Use at least 25 GB disk. Hosting hardening is maintained for Ubuntu, Fedora,
and RHEL-family Linux with systemd. Provider-specific pages use the same
`install.sh --hosting` command.

<CardGroup cols={2}>
  <Card title="Hetzner" href="/install/hetzner" icon="server">
    Provider creation notes.
  </Card>
  <Card title="DigitalOcean" href="/platforms/digitalocean" icon="server">
    Droplet creation notes.
  </Card>
  <Card title="Oracle Cloud" href="/platforms/oracle" icon="cloud">
    Oracle Linux notes.
  </Card>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    Stable updates and recovery.
  </Card>
</CardGroup>
