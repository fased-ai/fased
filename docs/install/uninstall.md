---
summary: "Uninstall Fased completely (CLI, service, state, workspace)"
read_when:
  - You want to remove Fased from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

# Uninstall

Two paths:

- **Easy path** if `fased` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
fased uninstall
```

Non-interactive:

```bash
fased uninstall --all --yes --non-interactive
```

Manual steps (same result):

1. Stop the gateway service:

```bash
fased gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
fased gateway uninstall
```

3. Delete state + config:

```bash
rm -rf "${FASED_STATE_DIR:-$HOME/.fased}"
```

If you set `FASED_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4. Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/.fased/workspace
```

5. Remove the repo-backed CLI launcher:

```bash
rm -f "${FASED_CLI_BIN_DIR:-$HOME/.local/bin}/fased"
```

If you used an older package-manager install, remove that package separately.

6. If you installed the macOS app:

```bash
rm -rf /Applications/FasedAgent.app
```

Notes:

- If you used profiles (`--profile` / `FASED_PROFILE`), repeat step 3 for each state dir (defaults are `~/.fased-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `fased` is missing.

### macOS (launchd)

Default label is `ai.fased.gateway` (or `ai.fased.<profile>`; legacy `com.fased.*` may still exist):

```bash
launchctl bootout gui/$UID/ai.fased.gateway
rm -f ~/Library/LaunchAgents/ai.fased.gateway.plist
```

If you used a profile, replace the label and plist name with
`ai.fased.<profile>`. Remove any legacy `com.fased.*` plists if present.

### Linux (systemd user unit)

Default unit name is `fased-gateway.service` (or `fased-gateway-<profile>.service`):

```bash
systemctl --user disable --now fased-gateway.service
rm -f ~/.config/systemd/user/fased-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `FasedAgent Gateway` (or `FasedAgent Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "FasedAgent Gateway"
Remove-Item -Force "$env:USERPROFILE\.fased\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.fased-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (repo `install.sh`)

If you used the repo-backed `install.sh`, uninstall the gateway service first.
Then remove the repo checkout and `~/.fased` data if you want a full wipe.

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `fased ...` / `bun run fased ...`):

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. Delete the repo directory.
3. Remove state + workspace as shown above.
