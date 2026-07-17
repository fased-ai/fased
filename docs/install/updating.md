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
- Their CLI and Gateway service resolve the active version through a stable
  launcher outside the versioned application directory.
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

For a managed Linux Local or WSL install, updates work from any directory:

```bash
fased update status
fased update
```

Source/developer checkouts should still run from their checkout directory.

On a hosted VPS, use the `app` user through Tailscale:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

After hosted onboarding, SSH as `app` should open directly in `/home/app/fased`.
If it does not, fix the hosted login/shell setup before updating.

For a fresh hosted VPS, use the
[pre-execution verified Hosting bootstrap](/install/vps#3-install-fased-and-connect-through-tailscale).
It downloads the standalone installer and attestation for an exact release,
verifies the repository, tag, release workflow, and GitHub-hosted runner, and
only then runs the verified file. Raw tagged `curl | bash` is not a supported
Hosting bootstrap.

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

Managed artifact updates require a Gateway restart and health verification;
`--no-restart` is accepted only when no runtime change is needed. Source and
manual package-manager profiles retain their existing restart option.

By default, `fased update` uses the **stable** channel. On a git checkout,
stable means the newest stable `v*` release tag. It does **not** mean the moving
head of `main`. On managed package installs, npm `latest` resolves the exact
version; the update downloads verified GitHub release layers and does not run a
global npm dependency reconciliation.

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

Privileged VPS Hosting refuses source checkouts. Test development Hosting work
on a disposable self-managed machine; do not run `/home/app/fased/install.sh`
with sudo or describe that setup as the maintained Hosting boundary.

## Native signer artifacts

Fresh dashboard, Gateway, and Fased Network setup do not require
`fased-signerd`. The native signer is only needed after you choose the local
signer wallet path.

When that path is enabled, Fased downloads the signer asset from the matching
versioned GitHub Release and verifies it against
`fased-signerd-checksums.txt` and the release's GitHub/Sigstore attestation.
The release also includes an attested `fased-signerd-release.json`. Hosting
accepts only a production identity whose exact version, commit, and build-input
digest match both that manifest and the running signer's health response;
development, missing, or mismatched identities fail closed.
Normal Local, WSL, macOS, and Hosting users do not need Go. WSL uses the Linux
asset; the Unix-socket signer is not supported by a native Windows Node.js
install. Verification failure stops the install instead of falling back to an
implicit source build.

When a Local install already has a native signer, `fased update` treats the
Gateway and signer as one transaction. It snapshots the current application
and signer state, stages the exact version-matched signer read-only, activates
the application, and requires exact Gateway and signer health before committing
the signer read-write. Before that durable health decision, a failure restores
both sides. After the decision, recovery completes forward so a signer database
that may have recorded a request is never replaced by an older snapshot.

This pairing also applies to tagged macOS and explicit source installs. A
source checkout with a configured signer must be clean, resolve to a production
release tag, allow the required restart, and pass the same exact health checks.
Signer-paired source updates reject an untagged development commit,
`--no-restart`, or an install-mode switch. Interrupted updates recover from the
owner-only transaction journal before the Gateway starts.

Each tagged release must publish signer assets for Linux and macOS on `amd64`
and `arm64` before wallet setup for that version is considered releasable. A
source checkout can still opt into a local build with
`FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE=1` and Go >= 1.25.7. Existing binaries
and alternate trusted release sources remain available through
`FASED_WALLET_LOCAL_SIGNER_BIN`, `FASED_LOCAL_SIGNER_VERSION`, and
`FASED_LOCAL_SIGNER_BASE_URL`.

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

The managed launcher and updater are deliberately outside each application
version:

```text
~/.fased/bin/fased
~/.fased/bin/fased-service
~/.fased/updater/fased-managed-updater.mjs
~/.fased/runtime/current
~/.fased/runtime/previous
~/.fased/runtime/releases/<version-or-repair-generation>/
~/.fased/install.json
```

`fased update` resolves the target online without stale npm cache metadata,
verifies checksums and archive paths, stages and smoke-tests the candidate,
switches `current` atomically, verifies Gateway identity and plugins, and rolls
back automatically on failure. Configuration, credentials, wallets, signer
state, mining data, sessions, and memory remain under the state directory and
are never part of the release swap.

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
provider still permits it). Follow the exact
[pre-execution verified release-asset procedure](/install/vps#3-install-fased-and-connect-through-tailscale),
but replace the final invocation of the already-verified standalone installer
with:

```bash
bash "$BOOTSTRAP_DIR/install.sh" --repair-hosting --release "$RELEASE"
```

Do not run this command unless the preceding `gh attestation verify` step
completed successfully for the same exact release. Remove `BOOTSTRAP_DIR` only
after the repair succeeds.

Do not run this command from the normal `app` Tailscale shell, and never run
`/home/app/fased/install.sh` with sudo. The restricted `app` account has no
sudo and no root bootstrap socket. The provider-console bootstrap verifies the
exact tagged app bundle attestation before loading any privileged assets.

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
Local users must not run `--repair-hosting`. If their historical Local/WSL
binary cannot complete `fased update`, use the Local repair command in the
support contract below.

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
  | bash -s -- --repair-local

hash -r
fased update status
fased update
fased --version
fased doctor
fased gateway restart
fased gateway status
fased plugins doctor
```

The Local/WSL bootstrap installs the current managed runtime, replaces only a
recognized installer-owned `fased` launcher, installs or refreshes the user
service, and verifies that the running Gateway reports the same version. It
does not overwrite an unrelated user-managed command and does not rerun
onboarding.

VPS Hosting bootstrap must run from the provider's root console. Follow the
[pre-execution verified release-asset procedure](/install/vps#3-install-fased-and-connect-through-tailscale)
for the exact release, then use `--repair-hosting` instead of `--hosting` only
in the final invocation of that already-verified standalone installer. Never
recover Hosting by piping a raw repository URL into a shell.

An immutable old binary cannot execute updater logic that was introduced in a
newer release. That one-time bootstrap is therefore unavoidable for a small set
of broken historical builds. It preserves configuration, credentials, wallets,
signer state, mining state, sessions, memory, and installed plugin records.
After the bootstrap installs the stable external updater, later application
versions cannot strand the update command inside an old release directory.

The bootstrap is complete only when `fased --version`, the Doctor header, and
the Gateway runtime agree, `RPC probe: ok` is reported, and plugin doctor is
clean. A CLI version alone is not sufficient proof because a legacy service can
still be running from an older source checkout.

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
