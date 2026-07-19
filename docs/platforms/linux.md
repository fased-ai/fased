---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
title: "Linux App"
---

# Linux App

The Gateway is fully supported on Linux. **Node is the normal runtime**. Bun is
experimental for the Gateway because some channel adapters depend on Node
behavior.

Native Linux companion apps are planned. Contributions are welcome.

## Beginner quick paths

For a Linux laptop or desktop, run:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --local
```

For an always-on VPS, SSH to the provider root shell and run the complete
[verified Hosting bootstrap block](/install/vps#3-verify-and-run-the-hosting-bootstrap).

The block authenticates the tagged installer before Bash executes it. The
verified Hosting installer then installs/starts Tailscale, creates the non-root
`app` runtime, and guides the private dashboard and SSH check. No source
checkout, manual Tailscale bootstrap, or SSH tunnel is part of the normal path.

Auto-install supports common Linux families: Ubuntu, Debian, Kali,
Fedora, CentOS, AlmaLinux, Rocky Linux, CloudLinux, Oracle Linux, Amazon Linux,
openSUSE, SLES, Alpine, and Arch. It uses the system package manager, installs
Node 24 where the platform supports it, then verifies `node:sqlite` before setup
continues.

Step-by-step VPS guide: [Hetzner](/install/hetzner) or the general
[VPS hosting](/install/vps) hub.

## Install

- [Getting Started](/start/getting-started)
- [Install & updates](/install/updating)
- Optional local flows: [Bun (experimental)](/install/bun), [Nix](/install/nix),
  [Docker (Local only)](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Use one of these:

```
fased onboard --install-daemon
```

Or:

```
fased gateway install
```

Or:

```
fased configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
fased doctor
```

## System control (systemd user unit)

Fased installs a systemd **user** service by default. Use a **system** service
only when you intentionally run a shared host-level service. The full unit
example and guidance live in the [Gateway runbook](/gateway).

Minimal setup:

Create `~/.config/systemd/user/fased-gateway[-<profile>].service`:

```
[Unit]
Description=Fased Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.local/bin/fased gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it:

```
systemctl --user enable --now fased-gateway[-<profile>].service
```
