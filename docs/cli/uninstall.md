---
summary: "Remove the installed gateway service and optionally local runtime data."
read_when:
  - You want to remove the gateway service and/or local state
  - You want a dry-run first
title: "uninstall"
---

# `fased uninstall`

Uninstall the gateway service and, if requested, the local runtime data while leaving the CLI itself installed.

```bash
fased uninstall
fased uninstall --all --yes
fased uninstall --service --yes
fased uninstall --state --workspace --yes
fased uninstall --dry-run
```

## Options

- `--service`: remove the gateway service
- `--state`: remove state and config
- `--workspace`: remove workspace directories
- `--app`: remove the macOS app
- `--all`: remove service, state, workspace, and app
- `--yes`: skip confirmation prompts
- `--non-interactive`: disable prompts; requires `--yes`
- `--dry-run`: print actions without removing files
