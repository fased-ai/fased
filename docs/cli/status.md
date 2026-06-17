---
summary: "Run a high-level runtime status check with channel probes and usage snapshots."
read_when:
  - You want a quick diagnosis of channel health + recent session recipients
  - You want a pasteable “all” status for debugging
title: "status"
---

# `fased status`

High-level diagnostics for channels, sessions, gateway runtime state, and optional usage snapshots.

Browser equivalents: **Dashboard** for compact health, **Logs** for live log
tail, **Usage** for token accounting, **Advanced > Debug** for raw snapshots,
and **Advanced > Nodes** for paired devices.

```bash
fased status
fased status --all
fased status --deep
fased status --usage
fased status --json
fased status --deep --timeout 5000
fased status --verbose
```

Notes:

- `--deep` runs live probes for WhatsApp Web, Telegram, Discord, Slack, and
  Signal.
- `--timeout <ms>` controls live probe timeout.
- `--verbose` and `--debug` enable verbose logging.
- `--json` prints machine-readable output.
- Output includes per-agent session stores when multiple agents are configured.
- Status output includes Gateway + node host service install/runtime state when
  available.
- Status output includes update channel + git SHA for source checkouts.
- Update info also surfaces in the Dashboard. If an update is available, status
  prints a hint to run `fased update` (see [Updating](/install/updating)).

Related:

- [Diagnostics](/diagnostics/index)
- [Usage tracking](/concepts/usage-tracking)
