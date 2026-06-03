---
summary: "Monitor provider OAuth expiry from the Fased CLI"
read_when:
  - Setting up auth expiry monitoring or alerts
  - Automating Claude Code or Codex OAuth refresh checks
title: "Auth Monitoring"
---

# Auth monitoring

Fased exposes model-provider auth health through the CLI. That is the source of
truth for scheduled tasks, systemd timers, shell scripts, and external monitors.

## Preferred check

```bash
fased models status --check
```

Exit codes:

- `0`: credentials look healthy
- `1`: credentials are missing or already expired
- `2`: credentials are close to expiry, currently within 24 hours

This is the best automation surface because it stays portable across local
setups, hosted gateways, cron, and systemd.

If you need richer output, use:

```bash
fased models status --json
```

## Optional scripts

The helper scripts under `scripts/` are convenience layers for personal ops
flows. They are not required for standard monitoring.

- `scripts/claude-auth-status.sh`
  - reads `fased models status --json` first
  - falls back to direct file inspection only if the CLI is unavailable
- `scripts/auth-monitor.sh`
  - timer-friendly wrapper for local alerts or phone notifications
- `scripts/systemd/fased-auth-monitor.{service,timer}`
  - user-level systemd timer units
- `scripts/mobile-reauth.sh`
  - guided SSH re-auth flow
- `scripts/termux-quick-auth.sh`
  - compact Termux widget helper
- `scripts/termux-auth-widget.sh`
  - fuller guided Termux flow
- `scripts/termux-sync-widget.sh`
  - sync helper for Claude Code credentials into Fased

If you do not need phone widgets or custom timer wrappers, skip the scripts and
monitor `fased models status --check` directly.
