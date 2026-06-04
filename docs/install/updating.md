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
- use the Control UI `Update & Restart` action when the gateway is healthy
- rerun `./install.sh` for repair/reinstall behavior

The update path should not require committing generated files. Native signer
artifacts, build outputs, and service state are install artifacts; keep source
changes separate from runtime refreshes.

`fased onboard --install-daemon` is setup and service installation. It is **not**
the primary version-update command.

## Recommended path

```bash
fased update status
fased update
```

On a hosted VPS, use the `app` user through Tailscale:

```bash
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
cd /home/app/agent
fased update status
fased update
```

## CLI update

```bash
fased update
fased update status
fased update --dry-run
fased update --no-restart
```

Use this when the runtime already lives on a repo checkout and you want the
gateway-aware update flow.

## Control UI update

The browser Control UI exposes the same runtime update path through
`Update & Restart`.

Use it when:

- the gateway is already healthy
- the repo checkout is the live runtime
- you want the restart report in the UI

## Installer rerun

Rerun `./install.sh` when you want repair/reinstall behavior. Current installers
try a clean fast-forward update from Git before dependency install and build. If
the installer itself changes, it restarts once and continues with the updated
script.

```bash
cd ~/fased
./install.sh --no-onboard
```

On hosted installs that live under `/home/app/agent`, run it as the app user:

```bash
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
cd /home/app/agent
./install.sh --no-onboard
```

Use `./install.sh --no-git-update` only when testing local changes.

## What onboard does versus what update does

`fased onboard --install-daemon`:

- configures the runtime
- installs or refreshes the service
- writes runtime env such as SAT ids into the installed runtime

`fased update`:

- updates code
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

Public package-manager update flows are not the default public docs path yet.

Until `fased` is actually published and supportable as a package, the official
docs assume:

- git checkout
- `./install.sh`
- `fased update`

## Related

- [Install](/install)
- [Installer internals](/install/installer)
- [CLI `update`](/cli/update)
- [CLI `onboard`](/cli/onboard)
