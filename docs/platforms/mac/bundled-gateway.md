---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging the macOS app bundle
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

# Gateway on macOS (external launchd)

The macOS app bundle no longer ships Node/Bun or the Gateway runtime. The app
expects an **external** `fased` CLI install, does not spawn the Gateway as a
child process, and manages a per‑user launchd service to keep the Gateway
running (or attaches to an existing local Gateway if one is already running).

## Install the CLI (required for local mode)

You need Node 24 recommended, or Node 22.14+ with `node:sqlite`, on the Mac.
Then install `fased` from the public repo checkout:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --no-onboard
```

The macOS app’s **Install CLI** button uses the Fased CLI installer and installs
into `~/.fased`. Use the manual repo-backed flow above when you are testing a
local checkout.

## Launchd (Gateway as LaunchAgent)

Label:

- `ai.fased.gateway` (or `ai.fased.<profile>`; legacy `com.fased.*` may remain)

Plist location (per‑user):

- `~/Library/LaunchAgents/ai.fased.gateway.plist`
  (or `~/Library/LaunchAgents/ai.fased.<profile>.plist`)

Manager:

- The macOS app owns LaunchAgent install/update in Local mode.
- The CLI can also install it: `fased gateway install`.

Behavior:

- The current app UI label is “FasedAgent Active”; it enables or disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.

Logging:

- launchd stdout/err: `/tmp/fased/fased-gateway.log`

## Version compatibility

The macOS app checks the gateway version against its own version. If they’re
incompatible, update the global CLI to match the app version.

## Smoke check

```bash
fased --version

FASED_SKIP_CHANNELS=1 \
FASED_SKIP_CANVAS_HOST=1 \
fased gateway --port 18999 --bind loopback
```

Then:

```bash
fased gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
