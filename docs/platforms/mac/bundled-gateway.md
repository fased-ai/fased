---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging the macOS app bundle
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

# Gateway on macOS (external launchd)

Managed macOS install/update is deferred from the first stable matrix. This
page describes compatibility and source-development behavior only; the app
does not download a separate npm/global CLI or claim a native managed
lifecycle.

## Install the CLI (required for local mode)

You need Node 24 recommended, or Node 22.14+ with `node:sqlite`, on the Mac.
Then install `fased` from a contributor checkout:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
bash scripts/install-development.sh --no-onboard
```

The macOS app has no public **Install CLI** authority. Use the manual
repo-backed flow above only when testing a local checkout.

## Launchd (Gateway as LaunchAgent)

Label:

- `ai.fased.gateway` (or `ai.fased.<profile>`; legacy `com.fased.*` may remain)

Plist location (per‑user):

- `~/Library/LaunchAgents/ai.fased.gateway.plist`
  (or `~/Library/LaunchAgents/ai.fased.<profile>.plist`)

Manager:

- The macOS app may manage a LaunchAgent only in compatibility/source mode.
- The CLI can also install it: `fased gateway install`.

Behavior:

- The current app UI label is “FasedAgent Active”; it enables or disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.

Logging:

- launchd stdout/err: `/tmp/fased/fased-gateway.log`

## Version compatibility

The macOS app checks the gateway version against its own version. This does not
turn the compatibility path into a supported managed release.

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
