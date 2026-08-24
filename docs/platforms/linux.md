---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
title: "Linux App"
---

# Linux App

Managed Local supports Linux x86_64 and arm64 with systemd, including Ubuntu
WSL2 x86_64 with systemd active. Managed artifacts bundle the matching exact
Node runtime, lifecycle supervisor, and signer. Hosting remains x86_64-only;
non-systemd managed installation is deferred.

Native Linux companion apps are planned. Contributions are welcome.

## Beginner quick paths

For a Linux laptop or desktop, run:

```bash
curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
  | bash -s -- --local
```

For an always-on VPS, SSH to the provider root shell and run the complete
[exact fresh Hosting command](/install/vps#3-install-fased).

The block authenticates the tagged installer before Bash executes it. The
verified Hosting installer then installs/starts Tailscale, creates the non-root
`app` runtime, and guides the private dashboard and SSH check. No source
checkout, manual Tailscale bootstrap, or SSH tunnel is part of the normal path.

The retained Hosting hardening matrix is Ubuntu-compatible and Rocky-compatible
x86_64. Other distribution adapters require separate package, rollback, and
command-backed acceptance before being advertised.

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

Managed installations use `fased update`, `fased repair`, and `fased uninstall`
through the root-owned Go lifecycle. The following are source-development
commands only:

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

## Source-development system control

Do not use a hand-written user unit for a managed installation. Managed Local
and Hosting use lifecycle-generated root-owned system units with isolated
service identities. The example below applies only to a contributor checkout.

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
