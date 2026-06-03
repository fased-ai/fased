---
summary: "Fetch gateway health over RPC from the terminal."
read_when:
  - You want to quickly check the running Gateway’s health
title: "health"
---

# `fased health`

Fetch health from the running gateway.

```bash
fased health
fased health --json
fased health --verbose
fased health --debug
fased health --timeout 5000
```

Notes:

- `--verbose` runs live probes and prints per-account timings when multiple accounts are configured.
- `--debug` is an alias for `--verbose`.
- `--timeout <ms>` controls the Gateway health request timeout.
- Output includes per-agent session stores when multiple agents are configured.
