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

- Supported Linux Local and VPS Hosting installs normally run a verified
  prebuilt release artifact.
- macOS and explicit `--source-install` installs run from the source checkout.
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

Run the first Hosting install from the VPS provider's root shell. That path
creates the non-root `app` runtime, private Tailscale access, and the hosted
security posture. After the installer hands off to `app`, use the Tailscale
hostname and the `app` account for normal operation and every normal update. A
successful fresh install does not require `--repair-hosting` afterward.

A manual global npm install is an advanced local/dev or self-managed-host path;
it is not the normal VPS Hosting path.

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

For development/testing from a source checkout, use the explicit source path:

```bash
git checkout main
git pull --ff-only origin main
./install.sh --source-install
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
refresh a clean checkout first. Supported Linux Local and VPS Hosting profiles
then prefer the verified prebuilt runtime artifact. macOS and explicit
`--source-install` runs refresh dependencies and build. If the installer itself
changes, it restarts once and continues with the updated script.

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
- uses the same verified artifact for supported Linux Local installs
- refreshes dependencies and rebuilds for macOS or explicit source installs
- checks tracked npm plugins after the core update
- detects the local user service or root-managed VPS Hosting service
- restarts the correct service and verifies Gateway health
- restores the previous packaged runtime automatically if post-update health fails

For a healthy supported install, `fased update` is the complete release update.
You should not need to clear npm caches, reinstall dependencies manually, or
run a separate Gateway repair command.

If the installed packaged version already matches the selected release,
`fased update` returns `Already current: <version>` without downloading an
artifact, changing plugins, or restarting the Gateway.

Supported Linux artifacts are layered. A fresh install downloads the
application and dependency layers once. Normal updates reuse the dependency
layer when its build hash is unchanged and replace only the application layer.
When the dependency recipe or lockfile changes, the next update replaces that
layer once and later updates reuse it again.

## Legacy hosted updater repair

Very old hosted releases may contain an updater that cannot install its own
replacement. A typical symptom is an update that reports success while
`fased --version` remains unchanged. Code added in a newer release cannot run
inside that already-installed old binary.

This is not a normal update and is not a follow-up step after a successful fresh
install. First log in as `app` over Tailscale and try `fased update`. Use this
repair only when that command cannot start, fails, or leaves the old version in
place.

The repair must restore root-owned service helpers and the system service. Open
the VPS provider's web/recovery console as `root` (or use root SSH only when the
provider still permits it), then run:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --repair-hosting
```

Do not run this command from the normal `app` Tailscale shell. The restricted
`app` account intentionally cannot replace arbitrary root-owned installer
helpers.

The repair keeps the existing `/home/app/fased` checkout and persistent
`/home/app/.fased` state. It refreshes the managed runtime, replaces a legacy
app-managed user service with the supported root-managed service, restarts the
Gateway, and skips onboarding. Wallets, mining state, credentials, sessions,
plugins, and configuration are not reset.

For Tailscale Serve, repair also keeps the Gateway on loopback, trusts only the
loopback proxy ranges, and removes the obsolete `allowInsecureAuth`
compatibility flag. Tailscale HTTPS, shared Gateway auth, and device/session
identity remain active.

After this one repair, return to the normal command:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
cd ~/fased
fased update status
fased update
fased --version
fased gateway status
fased plugins doctor
```

This repair is only for VPS Hosting installs with the root-managed service.
Local users should continue using `fased update`; they must not run
`--repair-hosting`.

## Update support contract

Use this order for every existing installation:

1. Run `fased update`.
2. Confirm the version changed when an update was available and the Gateway RPC
   probe is healthy.
3. If an old CLI cannot start, fails the update, or reports success without
   changing the version, bootstrap the runtime once with the matching Local or
   Hosting installer command below.
4. Return to `fased update` for every later release.

The bootstrap replaces application/runtime files, not user state. Do not delete
`~/.fased` or `/home/app/.fased`, and do not run fresh onboarding merely to fix
an old updater.

Local or WSL bootstrap:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --local --no-onboard
```

VPS Hosting bootstrap, run from the provider's root console:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --repair-hosting
```

An immutable old binary cannot execute updater logic that was introduced in a
newer release. That one-time bootstrap is therefore unavoidable for a small set
of broken historical builds. It preserves configuration, credentials, wallets,
signer state, mining state, sessions, memory, and installed plugin records.

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
- verified GitHub Release artifacts for supported Linux Local and VPS Hosting
  installs and updates
- source checkout builds for macOS and explicit `--source-install` workflows
- manual `npm install -g @fased/fased` is for advanced/local/manual installs,
  not the recommended hosted VPS setup flow

See [Core And Optional Components](/install/components) for channel add-ons,
local model servers, browser binaries, and local memory embeddings.

## Related

- [Install](/install)
- [Installer internals](/install/installer)
- [CLI `update`](/cli/update)
- [CLI `onboard`](/cli/onboard)
