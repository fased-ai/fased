---
summary: "Install Fased on Oracle Cloud ARM with the maintained Hosting profile"
read_when:
  - You want an always-on Fased node on Oracle Cloud
  - You need the supported ARM64 VPS path
title: "Oracle Cloud"
---

# Fased on Oracle Cloud (OCI)

Oracle Ampere ARM64 instances can run the maintained Fased Hosting profile.
Use the root-managed non-Docker installer; do not combine an app-owned checkout
with `sudo`, and do not use the older `./install.sh --no-onboard` plus user
daemon sequence for a VPS.

<Warning>
The full Docker Gateway is Local only. It is not the OCI VPS installation path,
and there is no `install.sh --hosting-docker` mode. Do not expose the raw
Gateway port (`18789`) through an OCI security list or public load balancer.
</Warning>

## 1. Create the instance

Create an Ubuntu 24.04 ARM64 instance with an SSH key. Use the general
[VPS sizing guidance](/install/vps#recommended-vps-size); 2 vCPU, 4 GB RAM, and
at least 25 GB disk is a practical starting point. Retain OCI Console/Rescue
access for emergency recovery.

## 2. Enter the provider root shell

```bash
ssh ubuntu@YOUR_PUBLIC_IP
sudo -i
```

The remaining installation commands run inside that root shell. Do not install
Node, Go, Docker, or Fased globally first.

## 3. Run the Hosting installer

From the provider root console, follow the
[one-command VPS Hosting guide](/install/vps). It verifies the tagged Hosting
release before privileged Fased installation.

The Hosting installer creates separate `app` and signer accounts, installs the
root-owned signer/updater systemd services, configures Tailscale and host
hardening, and coordinates app/signer update and rollback. Never grant the
`app` account sudo access.

## 4. Verify private access and Fased

Keep the OCI provider console open until a computer connected to the same
tailnet succeeds with:

```bash
tailscale ping YOUR_VPS_TAILSCALE_NAME
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
```

Then, as `app` on the instance:

```bash
fased health
fased --version
fased gateway status
fased plugins doctor
fased wallet signer doctor --json
```

Use the private dashboard URL printed by the installer. Keep OCI ingress
limited to the bootstrap and Tailscale requirements; do not publish the
dashboard or Gateway directly.

## Updates

As `app`, over Tailscale:

```bash
fased update status
fased update
fased health
```

See [VPS Hosting](/install/vps), [Tailscale](/gateway/tailscale),
[DigitalOcean](/platforms/digitalocean), and [Hetzner](/install/hetzner).
