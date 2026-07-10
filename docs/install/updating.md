---
summary: "Updating local and hosted Fased installs safely."
read_when:
  - Updating Fased
  - Understanding the difference between install, onboard, and update
  - Rolling forward or back on a repo checkout
title: "Updating"
---

# Updating

The public installer keeps a checkout as the setup and repair anchor. The
active runtime depends on the install profile:

- Local installs normally run from the source checkout.
- VPS Hosting installs normally run a verified prebuilt release artifact.
- `fased update` is the normal update command for both profiles.
- The Control UI currently reports update status; it does not start the update.
- Rerun `./install.sh` for repair or reinstall behavior.

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

Use this for the gateway-aware update flow on an existing install.

By default, `fased update` uses the **stable** channel. On a git checkout,
stable means the newest stable `v*` release tag. It does **not** mean the moving
head of `main`. On package installs, stable uses npm `latest` when the package
manager path is active and detected.

| Command                                                 | What it gets                                      |
| ------------------------------------------------------- | ------------------------------------------------- |
| `git clone https://github.com/fased-ai/fased.git fased` | Latest `main` checkout                            |
| `git pull --ff-only origin main`                        | Latest `main` checkout                            |
| `fased update`                                          | Latest stable release for the active install type |
| `fased update --channel dev`                            | Latest `main` checkout                            |

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

## Control UI update status

The browser Control UI shows read-only update state at:

```text
Advanced -> Debug -> Update Status
```

Use the CLI to run the update:

```bash
fased update status
fased update
```

The status card can show the current version, update channel, install source,
package or Git state, and whether an update is available. The actual update and
restart remain terminal operations.

## Installer rerun

Rerun `./install.sh` when you want repair/reinstall behavior. Current installers
refresh a clean checkout first. VPS Hosting then prefers the verified prebuilt
runtime artifact; Local source installs refresh dependencies and build. If the
installer itself changes, it restarts once and continues with the updated
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
- uses a verified release artifact for the managed VPS runtime when available
- refreshes dependencies and rebuilds for a Local source checkout
- checks tracked npm plugins after the core update
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
- `fased update` for normal updates
- verified GitHub Release artifacts for normal VPS Hosting installs and updates
- source checkout builds for the normal Local install path
- manual `npm install -g @fased/fased` is for advanced/local/manual installs,
  not the recommended hosted VPS setup flow

See [Core And Optional Components](/install/components) for channel add-ons,
local model servers, browser binaries, and local memory embeddings.

## Related

- [Install](/install)
- [Installer internals](/install/installer)
- [CLI `update`](/cli/update)
- [CLI `onboard`](/cli/onboard)
