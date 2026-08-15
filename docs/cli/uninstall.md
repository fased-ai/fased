---
summary: "Remove a managed Fased runtime while preserving user and signer state."
read_when:
  - You want to uninstall a managed Local or Hosting instance
  - You need the separate developer/source cleanup options
title: "uninstall"
---

# `fased uninstall`

For a Go-managed installation, this command enters the root-owned lifecycle
transaction. It stops and removes the exact generated services and executable
generations. It preserves configuration, workspaces, plugin data, Wallet/signer
custody, and durable service-account identity so a later verified reinstall can
reuse the state safely.

```bash
fased uninstall
fased uninstall --yes --non-interactive
fased uninstall --yes --non-interactive --json
```

Managed installations deliberately reject `--state`, `--workspace`, `--app`,
`--all`, and `--dry-run`. Removing user data is a separate destructive action;
it is never implied by removing the managed runtime.

## Developer/source checkout

When `FASED_RUNTIME_SOURCE` is not `go-lifecycle`, the unprivileged source CLI
retains its component cleanup options:

- `--service`: remove the gateway service
- `--state`: remove state and config
- `--workspace`: remove workspace directories
- `--app`: remove the macOS app
- `--all`: remove service, state, workspace, and app
- `--yes`: skip confirmation prompts
- `--non-interactive`: disable prompts; requires `--yes`
- `--dry-run`: print actions without removing files

These options are not a managed install/update authority.
