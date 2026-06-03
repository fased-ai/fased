---
summary: "Reset local config and state while leaving the CLI installed."
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `fased reset`

Reset local config and state while keeping the CLI itself installed on the machine.

This is the destructive admin path. It can remove `fased.json`, gateway
token/password, gateway settings, model/auth config refs, plugin config,
wallet assignments, Fased Network settings, and mining attachment config depending
on scope. It preserves wallet material, but you may need to rerun onboarding to
regain dashboard access or reconnect runtime services.

For normal repair, prefer:

```bash
fased onboard --reset
```

That onboarding repair path only clears selected auth/session state and keeps
gateway, wallet, mining, Fased Network, plugin, Tailscale, and firewall setup.

```bash
fased reset
fased reset --dry-run
fased reset --scope config --dry-run
fased reset --scope config+creds+sessions --yes --non-interactive
fased reset --scope full --yes --non-interactive --dry-run
```

Scopes:

- `config`: remove `fased.json` only.
- `config+creds+sessions`: remove config, OAuth/credential state, and session
  history; preserves wallets, workspace files, and Tailscale access.
- `full`: remove state and workspace directories while preserving wallet
  material.
