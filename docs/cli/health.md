---
summary: "Fetch gateway health over RPC from the terminal."
read_when:
  - You want to quickly check the running Gateway’s health
title: "health"
---

# `fased health`

Fetch health from the running Gateway. This is the first command to run after a
local or hosted install when you need one clear answer: is the Gateway online
and reachable from this checkout?

```bash
fased health
fased health --json
fased health --verbose
fased health --debug
fased health --timeout 5000
```

Notes:

- Default output starts with `Gateway: online` when the Gateway RPC path works.
- Optional disconnected channels are hidden by default so skipped channels do
  not look like install failures.
- `--verbose` shows optional channel details and runs live probes with
  per-account timings when multiple accounts are configured.
- `--debug` is an alias for `--verbose`.
- `--timeout <ms>` controls the Gateway health request timeout.
- Output includes per-agent session stores when multiple agents are configured.
