---
summary: "Install Fased on a fresh VPS in three steps with private Tailscale access."
read_when:
  - You want to run Fased continuously on a VPS
  - You need Hosting access or recovery guidance
title: "VPS Hosting"
---

# VPS Hosting

Use a fresh Ubuntu LTS VPS for the simplest supported path. Fased installs the
VPS-side Tailscale package from its signed operating-system repository; do not
run Tailscale's remote `curl | sh` installer.

## Install in 3 steps

### 1. Prepare your computer

Install and sign in to the [Tailscale app](https://tailscale.com/download) on
the computer where you will use Fased. Keep the VPS provider console available
for recovery.

### 2. Connect to the fresh VPS

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

The next command runs in this VPS root shell, not in a local PowerShell window.

### 3. Install Fased

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --hosting
```

Open the Tailscale login URL printed by the installer on your own computer.
When prompted, verify private SSH access before confirming it.

## After installation

Reconnect as the human operator, not as root or the Gateway service account:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased health
fased dashboard
```

Open the printed `https://...ts.net/` URL from a device on the same tailnet.
The `app` operator uses the restricted signer lifecycle socket;
`fased-gateway` runs the Gateway and cannot use that operator authority.

Normal updates are also operator commands:

```bash
fased update status
fased update
```

<AccordionGroup>
  <Accordion title="What the exact command verifies">
    The streamed script accepts only a fresh `--hosting` selector. It rejects
    repair, release and source overrides, caller-supplied verification markers,
    unsafe proxy or shell overrides, and existing Fased state.

    Before persistent Fased mutation, it resolves a stable tag and verifies the
    offline GitHub attestation bundle for the release manifest. That manifest
    binds the exact workflow, tag, source commit, architecture, application,
    dependency layer, and signer digests. Archive paths, links, ownership,
    writable modes, package version, and build identity are checked before the
    tagged installer receives control.

    The first mutable `main/install.sh` download remains a bootstrap trust
    assumption. Operators who require verification before any shell execution
    should use the exact-tag procedure below.

  </Accordion>

  <Accordion title="Advanced: verify install.sh before it runs">
    Follow the canonical
    [exact-tag pre-execution verification](/install/installer#exact-tag-pre-execution-verification).
    It authenticates the tagged `install.sh` before Bash runs it and is the only
    documented route for choosing a Hosting release override.
  </Accordion>

  <Accordion title="Hosting repair and recovery">
    Do not pipe `--repair-hosting` from `main`. From the provider root console,
    use the exact-tag verification block in the Advanced installer reference
    and change only its final line:

    ```bash
    bash "$BOOTSTRAP_DIR/install.sh" --repair-hosting --release "$RELEASE"
    ```

    If the streamed fresh install stops before `/var/lib/fased-installer`
    exists, fix the reported problem and rerun the exact normal command. If
    persistent installer state exists, use exact-tag repair instead.

  </Accordion>

  <Accordion title="Tailscale, VPN, and MagicDNS troubleshooting">
    Turn off another VPN while testing. From your own computer, try:

    ```bash
    tailscale status
    tailscale ping YOUR_VPS_TAILSCALE_NAME
    ssh app@YOUR_VPS_TAILSCALE_NAME
    ssh app@100.x.x.x
    ```

    `no matching peer` usually means the devices use different tailnets. A
    hostname-only failure usually means another VPN or DNS setting overrides
    MagicDNS. `tailscale ssh app@YOUR_VPS_TAILSCALE_NAME` is the fallback when
    regular SSH keys are unavailable.

  </Accordion>

  <Accordion title="Minimal images and supported hosts">
    Ubuntu or Debian:

    ```bash
    apt-get update
    apt-get install -y curl ca-certificates
    ```

    Fedora or RHEL family:

    ```bash
    dnf install -y curl ca-certificates
    ```

    Hosting hardening supports Ubuntu, Fedora, and RHEL-family Linux with
    systemd. Use at least 25 GB disk; 2 GB RAM is a practical small node.

  </Accordion>

  <Accordion title="Private-access boundary">
    Keep the Gateway private through Tailscale and retain provider-console plus
    Tailscale-account recovery. Other VPNs, public proxies, and custom firewall
    exposure are operator-managed deployments outside the normal installer.
  </Accordion>
</AccordionGroup>

## Provider notes

<CardGroup cols={2}>
  <Card title="Hetzner" href="/install/hetzner" icon="server">
    Server creation and recovery notes.
  </Card>
  <Card title="DigitalOcean" href="/platforms/digitalocean" icon="server">
    Droplet creation and console recovery.
  </Card>
  <Card title="Oracle Cloud" href="/platforms/oracle" icon="cloud">
    Oracle Linux notes.
  </Card>
  <Card title="Advanced installer" href="/install/installer" icon="terminal">
    Flags, restrictions, attestation, and repair.
  </Card>
</CardGroup>
