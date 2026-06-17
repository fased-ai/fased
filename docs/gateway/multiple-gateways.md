---
summary: "Run multiple Fased gateways on one host with isolated profiles, state, and ports."
read_when:
  - Running more than one Gateway on the same machine
  - You need isolated config/state/ports per Gateway
title: "Multiple Gateways"
---

# Multiple Gateways (same host)

Most setups should use one gateway because a single gateway can handle multiple
messaging connections and agents. If you need stronger isolation or redundancy,
such as a rescue profile, run separate gateways with isolated profiles and
ports.

## Isolation checklist (required)

- `FASED_CONFIG_PATH` — per-instance config file
- `FASED_STATE_DIR` — per-instance sessions, creds, caches
- `agents.defaults.workspace` — per-instance workspace root
- `gateway.port` (or `--port`) — unique per instance
- Derived browser ports must not overlap

If these are shared, you will hit config races and port conflicts.

## Recommended: profiles (`--profile`)

Profiles auto-scope `FASED_STATE_DIR` + `FASED_CONFIG_PATH` and suffix service
names.

```bash
# main
fased --profile main setup
fased --profile main gateway --port 18789

# rescue
fased --profile rescue setup
fased --profile rescue gateway --port 19001
```

Per-profile services:

```bash
fased --profile main gateway install
fased --profile rescue gateway install
```

## Rescue-bot guide

Run a second Gateway on the same host with its own:

- profile/config
- state dir
- workspace
- base port plus derived browser ports

This keeps the rescue bot isolated from the main bot so it can debug or apply
config changes if the primary bot is down.

Port spacing: leave at least 20 ports between base ports so the derived
browser/CDP ports never collide.

### How to install (rescue bot)

```bash
# Main bot
# Runs on port 18789 plus derived browser ports
fased onboard
fased gateway install

# Rescue bot (isolated profile + ports)
fased --profile rescue onboard
# Notes:
# - workspace name is suffixed with -rescue by default
# - leave at least 20 ports between base ports
# - a clearly separated base port like 19789 is easier to reason about

# To install the service (if not happened automatically during onboarding)
fased --profile rescue gateway install
```

## Port mapping (derived)

Base port = `gateway.port` (or `FASED_GATEWAY_PORT` / `--port`).

- browser control service port = base + 2 (loopback only)
- extension relay CDP port = browser control + 1
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108`.
- canvas host is served on the Gateway HTTP server (same port as `gateway.port`)

If you override any of these in config or env, keep them unique per instance.

For hosted setups, keep each gateway loopback-first unless a specific instance
needs a tailnet bind or proxy exposure.

## Browser/CDP notes (common footgun)

- Do **not** pin `browser.cdpUrl` to the same values on multiple instances.
- Each instance needs its own browser control port and CDP range. The range is
  derived from its gateway port.
- If you need explicit CDP ports, set `browser.profiles.<name>.cdpPort` per
  instance.
- Remote Chrome: use `browser.profiles.<name>.cdpUrl` (per profile, per instance).

## Manual env example

```bash
FASED_CONFIG_PATH=~/.fased/main.json \
FASED_STATE_DIR=~/.fased-main \
fased gateway --port 18789

FASED_CONFIG_PATH=~/.fased/rescue.json \
FASED_STATE_DIR=~/.fased-rescue \
fased gateway --port 19001
```

## Quick checks

```bash
fased --profile main status
fased --profile rescue status
fased --profile rescue browser status
```
