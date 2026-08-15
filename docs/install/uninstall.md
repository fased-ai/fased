---
summary: "Safely uninstall managed Fased while preserving state, or clean a source checkout."
read_when:
  - You want to remove Fased from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

# Uninstall

Two distinct paths:

- **Managed Local/Hosting** uses the verified Go lifecycle and preserves data.
- **Developer/source or legacy cleanup** uses the unprivileged/manual tools.

## Managed Local or Hosting

Recommended: use the built-in uninstaller:

```bash
fased uninstall
```

Non-interactive:

```bash
fased uninstall --yes --non-interactive
```

The transaction:

- restores only Hosting Tailscale, private Serve, signer WebAuthn, firewall,
  SSH, fail2ban, and automatic-update controls that the first managed install
  recorded as Fased-owned;
- stops, disables, and removes the exact generated Gateway, signer, and
  lifecycle-supervisor services;
- removes executable generations and managed projections;
- preserves `~/.fased`, workspaces, plugin data, signer custody, and durable
  account identity for a safe verified reinstall;
- records monotonic progress so an interrupted uninstall can resume.

Managed uninstall rejects `--state`, `--workspace`, `--app`, `--all`, and
`--dry-run`. Back up and erase preserved data only as a separate, explicit
owner action after uninstall has completed.

## Developer/source or legacy cleanup

The following manual steps do **not** replace the managed Go transaction. Use
them only for a source checkout or an older installation that never entered the
Go lifecycle.

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

## Legacy manual service removal (CLI not installed)

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

### Legacy native Windows installs (Scheduled Task)

The current public Windows path runs inside WSL2 and uses the Linux/systemd
instructions above. Use this section only to clean up an older native Windows
installation created before WSL2 became the required public path.

Default task name is `FasedAgent Gateway` (or `FasedAgent Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "FasedAgent Gateway"
Remove-Item -Force "$env:USERPROFILE\.fased\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.fased-<profile>\gateway.cmd`.

## Source checkout (git clone)

If you run from a repo checkout with the installed `fased` command:

1. Uninstall the source gateway service **before** deleting the repo (use the developer/source steps above).
2. Delete the repo directory.
3. Remove state + workspace as shown above.
