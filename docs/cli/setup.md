---
summary: "Initialize local config and workspace without running the full onboarding flow."
read_when:
  - You’re doing first-run setup without the full onboarding wizard
  - You want to set the default workspace path
title: "setup"
---

# `fased setup`

Initialize `~/.fased/fased.json` and the default workspace without going through the full onboarding flow.

Related:

- Getting started: [Getting started](/start/getting-started)
- Wizard: [Onboarding](/start/onboarding)

## Examples

```bash
fased setup
fased setup --workspace ~/.fased/workspace
```

To run the wizard via setup:

```bash
fased setup --wizard
fased setup --wizard --mode remote --remote-url ws://gateway-host:18789
fased setup --wizard --mode remote --remote-url ws://gateway-host:18789 --remote-token <token>
fased setup --wizard --non-interactive
```

`setup` without `--wizard` only initializes config/workspace. `--wizard` hands
off to the onboarding flow and accepts the wizard flags shown above.
