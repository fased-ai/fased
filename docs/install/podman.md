---
summary: "Run Fased in a rootless Podman container"
read_when:
  - You want a containerized gateway with Podman instead of Docker
title: "Podman"
---

# Podman

Run the Fased gateway in a **rootless** Podman container. It uses the same image
as Docker, built from the repo
[Dockerfile](https://github.com/fased-ai/fased/blob/main/Dockerfile).

## Requirements

- Podman (rootless)
- Sudo for one-time setup (create user, build image)

## Quick start

**1. One-time setup** from repo root. This creates the user, builds the image,
and installs the launch script:

```bash
./setup-podman.sh
```

This also creates a minimal `~fased/.fased/fased.json` with
`gateway.mode="local"` so the gateway can start without interactive onboarding.

By default, the container is **not** installed as a systemd service; you start it
manually. For auto-start and restarts, install it as a systemd Quadlet user
service:

```bash
./setup-podman.sh --quadlet
```

Or set `FASED_PODMAN_QUADLET=1`. Use `--container` to install only the
container and launch script.

**2. Start gateway** (manual, for quick smoke testing):

```bash
./scripts/run-fased-podman.sh launch
```

**3. Optional CLI onboarding** (host/runtime repair or scripted setup):

```bash
./scripts/run-fased-podman.sh launch setup
```

Then open `http://localhost:18789/` and use the token from
`~fased/.fased/.env` (or the value printed by setup). Finish normal setup in the
Control UI from the selected Agent:

- **Agent > Models** for model provider auth and model roles
- **Chat** for the first working message
- **Agent > Channels** for Telegram, Discord, WhatsApp, and other chat routes
- **Agent > Services** for web/search, GitHub, Gmail, and other API connectors

## Systemd (Quadlet, optional)

If you ran `./setup-podman.sh --quadlet` or set `FASED_PODMAN_QUADLET=1`, a
[Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
unit is installed so the gateway runs as a systemd user service for the `fased`
user. The service is enabled and started at the end of setup.

- **Start:** `sudo systemctl --machine fased@ --user start fased.service`
- **Stop:** `sudo systemctl --machine fased@ --user stop fased.service`
- **Status:** `sudo systemctl --machine fased@ --user status fased.service`
- **Logs:** `sudo journalctl --machine fased@ --user -u fased.service -f`

The quadlet file lives at `~fased/.config/containers/systemd/fased.container`.
To change ports or env, edit that file or the `.env` it sources, then reload and
restart the service:

```bash
sudo systemctl --machine fased@ --user daemon-reload
sudo systemctl --machine fased@ --user restart fased.service
```

On boot, the service starts automatically if lingering is enabled for `fased`.
Setup enables lingering when `loginctl` is available.

To add quadlet **after** an initial setup that did not use it, re-run: `./setup-podman.sh --quadlet`.

## The fased user (non-login)

`setup-podman.sh` creates a dedicated system user `fased`:

- **Shell:** `nologin` — no interactive login; reduces attack surface.
- **Home:** for example `/home/fased`; holds `~/.fased` config/workspace and
  the launch script `run-fased-podman.sh`.
- **Rootless Podman:** the user must have a **subuid** and **subgid** range. Many
  distros assign these automatically when the user is created. If setup prints a
  warning, add lines to `/etc/subuid` and `/etc/subgid`:

  ```text
  fased:100000:65536
  ```

  Then start the gateway as that user (e.g. from cron or systemd):

  ```bash
  sudo -u fased /home/fased/run-fased-podman.sh
  sudo -u fased /home/fased/run-fased-podman.sh setup
  ```

- **Config:** only `fased` and root can access `/home/fased/.fased`. To edit
  config, use the Control UI once the gateway is running, or:

  ```bash
  sudo -u fased $EDITOR /home/fased/.fased/fased.json
  ```

## Environment and config

- **Token:** stored in `~fased/.fased/.env` as `FASED_GATEWAY_TOKEN`.
  `setup-podman.sh` and `run-fased-podman.sh` generate it if missing.
- **Optional env:** in that `.env`, you can set provider keys such as
  `GROQ_API_KEY`, `OLLAMA_API_KEY`, and other Fased env vars.
- **Host ports:** by default, the script maps `18789` (gateway) and `18790`
  (bridge). Override host ports with `FASED_PODMAN_GATEWAY_HOST_PORT` and
  `FASED_PODMAN_BRIDGE_HOST_PORT` when launching.
- **Gateway bind:** by default, `run-fased-podman.sh` starts the gateway with
  `--bind loopback` for local-only access. To expose on LAN, set
  `FASED_GATEWAY_BIND=lan` and configure `gateway.controlUi.allowedOrigins`, or
  explicitly enable host-header fallback in `fased.json`.
- **Paths:** host config and workspace default to `~fased/.fased` and
  `~fased/.fased/workspace`. Override launch-script host paths with
  `FASED_CONFIG_DIR` and `FASED_WORKSPACE_DIR`.

## Useful commands

- **Logs**
  - Quadlet: `sudo journalctl --machine fased@ --user -u fased.service -f`
  - Script: `sudo -u fased podman logs -f fased`
- **Stop**
  - Quadlet: `sudo systemctl --machine fased@ --user stop fased.service`
  - Script: `sudo -u fased podman stop fased`
- **Start again**
  - Quadlet: `sudo systemctl --machine fased@ --user start fased.service`
  - Script: re-run the launch script or `podman start fased`
- **Remove container:** `sudo -u fased podman rm -f fased`; config and workspace
  on the host are kept.

## Troubleshooting

- **Permission denied (EACCES) on config or auth-profiles:** the container
  defaults to `--userns=keep-id` and runs as the same uid/gid as the host user
  running the script. Ensure `FASED_CONFIG_DIR` and `FASED_WORKSPACE_DIR` are
  owned by that user.
- **Gateway start blocked (missing `gateway.mode=local`):** ensure
  `~fased/.fased/fased.json` exists and sets `gateway.mode="local"`.
  `setup-podman.sh` creates this file if missing.
- **Rootless Podman fails for user fased:** check `/etc/subuid` and
  `/etc/subgid` contain a line for `fased`, for example `fased:100000:65536`.
  Add it if missing and restart.
- **Container name in use:** the launch script uses `podman run --replace`, so
  the existing container is replaced when you start again. To clean up manually:
  `podman rm -f fased`.
- **Script not found when running as fased:** ensure `setup-podman.sh` copied
  `run-fased-podman.sh` to `/home/fased/run-fased-podman.sh`.
- **Quadlet service not found or fails to start:** run
  `sudo systemctl --machine fased@ --user daemon-reload` after editing the
  `.container` file. Quadlet requires cgroups v2:
  `podman info --format '{{.Host.CgroupsVersion}}'` should show `2`.

## Optional: run as your own user

To run the gateway as your normal user, build the image, create `~/.fased/.env`
with `FASED_GATEWAY_TOKEN`, and run the container with `--userns=keep-id` and
mounts to your `~/.fased`. The launch script is designed for the `fased` user
flow. For a single-user setup, run the `podman run` command from the script
manually and point config/workspace to your home. For most users,
`setup-podman.sh` with the dedicated `fased` user keeps config and process
isolation cleaner.
