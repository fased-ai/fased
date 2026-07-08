---
summary: "Updating Fased safely with the current repo-backed install flow."
read_when:
  - Updating Fased
  - Understanding the difference between install, onboard, and update
  - Rolling forward or back on a repo checkout
title: "Updating"
---

# Updating

Current public installs are repo-backed.

That means the current update paths are:

- use `fased update` for normal running systems
- use the Control UI update action only when the UI build shows it and the
  gateway is healthy
- rerun `./install.sh` for repair/reinstall behavior

The update path should not require committing generated files. Native signer
artifacts, build outputs, and service state are install artifacts; keep source
changes separate from runtime refreshes.

`fased onboard --install-daemon` is setup and service installation. It is **not**
the primary version-update command.

## Recommended path

For a local install, open a terminal in the Fased install directory first:

```bash
cd ~/fased
fased update status
fased update
```

On a hosted VPS, use the `app` user through Tailscale:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

After hosted onboarding, SSH as `app` should open directly in `/home/app/fased`.
If it does not, fix the hosted login/shell setup before updating.

For hosted VPS installs, the recommended setup path is the hosted installer:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --hosting
```

That path sets up the non-root `app` runtime, private Tailscale access, and the
hosted security posture. A manual global npm install is an advanced local/dev or
self-managed-host path; it is not the normal VPS hosting path.

## CLI update

```bash
fased update
fased update status
fased update --dry-run
fased update --no-restart
```

Use this when the runtime already lives on a repo checkout and you want the
gateway-aware update flow.

By default, `fased update` uses the **stable** channel. On a git checkout,
stable means the newest stable `v*` release tag. It does **not** mean the moving
head of `main`. On package installs, stable uses npm `latest` when the package
manager path is active and detected.

| Command                                                 | What it gets              |
| ------------------------------------------------------- | ------------------------- |
| `git clone https://github.com/fased-ai/fased.git fased` | Latest `main` checkout    |
| `git pull --ff-only origin main`                        | Latest `main` checkout    |
| `fased update`                                          | Latest stable release tag |
| `fased update --channel dev`                            | Latest `main` checkout    |

Use this for normal end-user updates:

```bash
cd ~/fased
fased update status
fased update
```

Use the developer channel only when you intentionally want the latest commits
from `main`:

```bash
fased update --channel dev
```

For development/testing from a source checkout, the manual equivalent is:

```bash
git checkout main
git pull --ff-only origin main
./install.sh
```

On a hosted VPS, run the development checkout flow as `app` from
`/home/app/fased` and use `./install.sh --hosting`.

## Native signer artifacts

Fresh dashboard, Gateway, and Fased Network setup do not require
`fased-signerd`. The native signer is only needed after you choose the local
signer wallet path.

When that path is enabled, Fased first tries to build `fased-signerd` locally
from source when Go >= 1.21 is available. If Go is not available, provide either
an existing signer binary with `FASED_WALLET_LOCAL_SIGNER_BIN` or an explicit
asset source with `FASED_LOCAL_SIGNER_VERSION` / `FASED_LOCAL_SIGNER_BASE_URL`.

Do not commit generated signer binaries to Git, and do not cut a release just to
test signer setup.

## Control UI update

The browser Control UI shows update state at:

```text
Advanced -> Debug -> Update Status
```

If your UI build shows an **Update & Restart** action there, it uses the same
gateway update runner as `fased update`.

Use it when:

- the gateway is already healthy
- the UI is reachable
- the visible update action is shown
- you want the restart/report in the UI

It uses the configured update channel. Stable is the default and resolves to the
latest stable release tag for repo-backed installs.

If the visible update action is not shown, use the CLI:

```bash
fased update status
fased update
```

Use the CLI whenever the Gateway is down, the browser cannot connect, or support
needs terminal logs.

## Installer rerun

Rerun `./install.sh` when you want repair/reinstall behavior. Current installers
try a clean fast-forward update from Git before dependency install and build. If
the installer itself changes, it restarts once and continues with the updated
script.

```bash
cd ~/fased
./install.sh --no-onboard
```

On hosted installs that live under `/home/app/fased`, run it as the app user:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
./install.sh --no-onboard
```

The `app` shell starts in `/home/app/fased`.

Use `./install.sh --no-git-update` only when testing local changes.

## What onboard does versus what update does

`fased onboard --install-daemon`:

- configures the runtime
- installs or refreshes the service
- writes runtime env such as SAT ids into the installed runtime

`fased update`:

- updates to the configured channel; stable is the default end-user channel
  and resolves to the newest stable release tag
- rebuilds
- refreshes the installed runtime
- restarts when needed

`./install.sh`:

- installs or repairs dependencies
- rebuilds
- refreshes the CLI/runtime
- runs onboarding unless `--no-onboard` is set

## Update sequence

1. check update status
2. run update
3. run `fased doctor`
4. verify dashboard, wallet, Fased Network, and other critical surfaces

Example:

```bash
fased update status
fased update
fased doctor
fased status
fased dashboard
```

## SAT runtime IDs during update

Pre-launch updates keep Satcoin runtime IDs empty unless you explicitly set a
test network. After official mainnet launch proof is published, use **Mining >
Sync** to verify the signed manifest and write:

```text
config/sat-runtime.env
```

Later releases may include final mainnet IDs, but Sync remains the preferred
check because it verifies the live official manifest.

## Rollback

If a new checkout is bad, roll back to an earlier commit or tag, then rerun the
installer:

```bash
git checkout <tag-or-commit>
./install.sh --no-onboard
```

Then verify:

```bash
fased doctor
fased status
```

## Current public boundary

Fresh installs and hosted systems should use the curl bootstrap:

- curl bootstrap for fresh local machines, WSL2, and hosted VPS
- `fased update` for repo-backed installs
- published package payloads may be used by the installer internally
- manual `npm install -g @fased/fased` is for advanced/local/manual installs,
  not the recommended hosted VPS setup flow

## Related

- [Install](/install)
- [Installer internals](/install/installer)
- [CLI `update`](/cli/update)
- [CLI `onboard`](/cli/onboard)
