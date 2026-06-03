---
summary: "How the macOS app reports gateway and channel health states"
read_when:
  - Debugging mac app health indicators
title: "Health Checks"
---

# Health Checks on macOS

How to see whether the Gateway and linked channels are healthy from the menu bar app.

## Menu bar

- Status dot reflects Gateway/channel health:
  - Green: gateway reachable and linked channel sockets opened recently when channel data is available.
  - Orange: connecting/retrying.
  - Red: logged out or probe failed.
- Secondary line reads "linked · auth 12m" or shows the failure reason.
- "Run Health Check" menu item triggers an on-demand probe.

## Settings

- General tab gains a Health card showing: linked auth age, session-store path/count, last check time, last error/status code, and buttons for Run Health Check / Reveal Logs.
- Uses a cached snapshot so the UI loads instantly and falls back gracefully when offline.
- Channel account setup and routing are managed in the browser Control UI under
  **Agent > Channels**. The macOS app can surface health, but it is not the
  source of truth for Agent routing.

## How the probe works

- App runs `fased health --json` via `ShellExecutor` every ~60s and on demand. The probe loads creds and reports status without sending messages.
- Cache the last good snapshot and the last error separately to avoid flicker; show the timestamp of each.

## When in doubt

- You can still use the CLI flow in [Gateway health](/gateway/health)
  (`fased status`, `fased status --deep`, `fased health --json`) and
  `fased logs --follow` for gateway diagnostics.
