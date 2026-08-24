---
summary: "Updating local and hosted Fased installs safely."
read_when:
  - Updating Fased
  - Understanding the difference between install, onboard, and update
  - Rolling forward or back on a repo checkout
title: "Updating"
---

# Updating

The public installer installs a verified bootstrap and generation; managed
users do not maintain a source checkout. The active runtime depends on the
install profile:

- Supported Linux/WSL2/macOS Local and Linux VPS Hosting installs run verified
  prebuilt release artifacts.
- Their CLI and Gateway service resolve the active version through a stable
  launcher outside the versioned application directory.
- Managed Local and VPS Hosting coordinate the application and signer through
  a root-owned paired release controller using systemd or launchd.
- Explicit `--source-install` installs run from the source checkout.
- `fased update` is the normal update command for both profiles.
- A Local installation from before the protected supervisor handoff, or one
  with an incomplete legacy flat updater bundle, uses the documented Local
  installer once; that verified bootstrap preserves state, skips onboarding,
  and makes every later release use `fased update`.
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

If a historical Local installation predates the protected supervisor, or its
legacy updater cannot start because its bundle is incomplete, run the same
documented Local installer once:

```bash
curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
  | bash -s -- --local
```

The installer detects recognized pre-supervisor or incomplete-updater state,
verifies the selected release, performs one state-preserving protected
bootstrap, and does not rerun onboarding. After it succeeds, return
permanently to `fased update`.

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
[exact fresh Hosting command](/install/vps#3-install-fased) from the VPS
provider root shell.

The verified script installs the exact selected release and verifies the tagged Hosting
artifacts before privileged Fased installation. Users who require verification
before the first script runs can use the expandable advanced procedure in
[Advanced installer](/install/installer#exact-tag-pre-execution-verification).

Run the first Hosting install from the VPS provider's root shell. That path
creates the human `app` operator, isolated `fased-gateway` and `fased-signer`
services, private Tailscale access, and the hosted posture. Use the Tailscale
hostname and `app` for normal operation and updates. A successful fresh install
does not require `--repair-hosting` afterward.

Legacy global npm installs are migration-only. Rerun the verified public
installer to enter the managed layout; npm is not a maintained Local or Hosting
lifecycle authority.

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
head of `main`. On managed installs, the signed release index resolves the exact
version and architecture-specific GitHub release layers without npm registry
metadata or global dependency reconciliation.

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

Every managed Local and Hosting generation includes `fased-signerd`. The Go
lifecycle stages Gateway, signer, and controller together and requires their
exact managed services to become healthy before onboarding completes. Wallet
creation can still be deferred; that choice does not remove the signer from the
managed service transaction.

Fased downloads the signer asset from the matching versioned GitHub Release and
verifies it against `fased-signerd-checksums.txt` and the release's
GitHub/Sigstore attestation.
The release also includes an attested `fased-signerd-release.json`. Hosting
accepts only a production identity whose exact version, commit, and build-input
digest match both that manifest and the running signer's health response;
development, missing, or mismatched identities fail closed.
Normal supported Linux Local, Ubuntu WSL2 Local, macOS Local, and Hosting users
do not need Go. Native Windows Node.js cannot use the Unix-socket signer.
Verification failure stops installation instead of falling back to an implicit
source build.

Protected Local Linux treats the Gateway, signer, and controller as one
root-coordinated transaction. It stages the exact version-matched signer,
activates the application, and requires exact Gateway and signer health before
commit. Before that durable decision, failure restores the previous runtime and
signer state. After the decision, recovery completes forward so a signer
database that may have recorded a request is never replaced by an older
snapshot.

Older same-user Local installations and source checkouts with signer state do
not mutate the application and signer from the Node updater. During the Go
lifecycle cutover they fail closed and require the verified public installer to
enter or repair the managed layout. An already-published updater cannot acquire
new privileged migration behavior inside the same running process. Release
notes must name the oldest topology that can perform the one-command transition;
do not claim arbitrary historical versions migrate automatically.

Each tagged release must publish signer assets for Linux and macOS on `amd64`
and `arm64` before wallet setup for that version is considered releasable. A
source checkout can still opt into a local build with
`FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE=1` and Go >= 1.25.13. Existing binaries
and alternate trusted release sources remain available through
`FASED_WALLET_LOCAL_SIGNER_BIN`, `FASED_LOCAL_SIGNER_VERSION`, and
`FASED_LOCAL_SIGNER_BASE_URL`.

Existing Local/WSL2 SAT operators that explicitly use large distribution v0
transactions keep `FASED_SAT_ENABLE_ALT_V0` and `FASED_SAT_PROGRAM_ID` from
managed config across restart/update. An update does not silently enable the
feature or widen signer policy; exact `satLookup` grants still require
owner-policy acknowledgement.

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

Rerun `./install.sh` only for a Local/source checkout repair or contributor
workflow. Current installers refresh a clean checkout first. Supported Linux
Local profiles then prefer the verified prebuilt runtime artifact. macOS and
explicit `--source-install` runs refresh dependencies and build. If the
installer itself changes, it restarts once and continues with the updated
script.

```bash
cd ~/fased
./install.sh --no-onboard
```

Do not rerun `/home/app/fased/install.sh` on Hosting, with or without `sudo`.
Use `fased update` from the `app` shell for normal Hosting updates. Use the
same public one-command Hosting bootstrap from the VPS provider root console
only when a legacy root controller cannot replace itself or the root-owned
service is broken. The bootstrap detects the existing installation and selects
the internal verified repair path automatically.

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
- uses the matching verified platform artifact for Linux/WSL2/macOS Local
- refreshes dependencies and rebuilds only for explicit source installs
- updates every Fased-owned channel and runtime component atomically with the
  signed application generation
- detects the exact protected Local per-instance system service, legacy Local
  user service, or root-managed VPS Hosting service
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

The stable launcher and lifecycle host are deliberately outside each
application version:

```text
/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap
/opt/fased/lifecycle/supervisor-v1/fased-lifecycled
/opt/fased/<profile>/<instance>/current
/opt/fased/<profile>/<instance>/generations/<generation-id>/
~/.fased/plugin.lock.json
```

`fased update` resolves the signed target without npm registry metadata,
verifies checksums and archive paths, stages and health-checks the candidate,
switches `current` atomically, verifies Gateway identity and plugins, and rolls
back automatically on failure. Configuration, credentials, wallets, signer
state, mining data, sessions, and memory remain under the state directory and
are never part of the release swap.

## Legacy hosted updater repair

Older hosted releases may have no root controller or a root controller that
cannot replace itself. A typical symptom is `fased update` stopping with the
one-time Hosting bootstrap instruction while leaving the running Gateway,
signer, wallets, and state unchanged. New unprivileged application code cannot
safely replace that old root component by itself.

This is not a normal update and is not a follow-up step after a successful fresh
install. If the install is known to predate the external managed updater, or
`fased update` already failed or left the version unchanged, do not repeatedly
run the old updater.

Open the VPS provider's web/recovery console as `root` (or use root SSH only
when the provider still permits it) and rerun the
[one-command Hosting bootstrap](/install/vps#3-install-fased).

Do not run this command from the normal `app` Tailscale shell, and never run
`/home/app/fased/install.sh` with sudo. The restricted `app` account has no
sudo and no root bootstrap socket. The provider-console bootstrap detects the
existing installation, verifies the immutable release manifest, offline
attestation bundles, application, dependency, and signer digests, then selects
the internal repair path. It performs controller, signer, application, service,
and state convergence transactionally and skips onboarding.

The repair keeps the existing `/home/app/fased` checkout and persistent
`/home/app/.fased` state. It refreshes the managed runtime, replaces a legacy
app-managed user service with the supported root-managed service, restarts the
Gateway, and skips onboarding. Wallets, mining state, credentials, sessions,
plugins, and configuration are not reset.

For Tailscale Serve, repair also keeps the Gateway on loopback, trusts only the
loopback proxy ranges, and removes the obsolete `allowInsecureAuth`
compatibility flag. Tailscale HTTPS, shared Gateway auth, and device/session
identity remain active.

For an exact beta candidate, use the immutable beta selector documented on the
[VPS Hosting page](/install/vps).

The
[exact-tag pre-execution verification procedure](/install/installer#exact-tag-pre-execution-verification)
remains available as an optional stronger control for operators who want to
authenticate `install.sh` before its first shell executes. It is not required
for ordinary recovery.

After the one-time bootstrap succeeds, return to the normal command:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
cd ~/fased
fased update status
fased update
fased --version
fased gateway status
fased plugins doctor
```

This bootstrap recovery is only for VPS Hosting installs. Local users must not
run `--repair-hosting`. A recognized pre-handoff Local/WSL installation uses
the normal documented Local installer once, then returns to `fased update`.

### One-time pre-v2 Local wallet migration

If `fased update` reports a pre-v2 Local wallet, it stops **before** stopping a
process or replacing a file. This is intentional: the updater and Gateway must
not read an old wallet passphrase. First make an offline backup and record the
public address. Run the exact tagged Local repair later on this page if the old
CLI lacks the native signer admin path; it leaves legacy wallet material
untouched. Put the old passphrase in a separate owner-only file, run
`fased-signerd admin wallet import-legacy` with the wallet's permanent Agent,
Mining, or Vault role, and compare the returned
public address with the address recorded before migration. Then finalize the
non-secret config/registry conversion:

```bash
fased wallet finalize-legacy-migration --wallet-id agent
fased wallet signer doctor --json
fased update
```

The native signer reads and consumes the encrypted keystore/passphrase paths.
Do not put the passphrase in `FASED_WALLET_PASSPHRASE`, command arguments,
PowerShell, the dashboard, chat, or a skill. WSL2 users run all three Bash
blocks in the Ubuntu shell, not PowerShell. Existing signer-v2 updates remain
automatic and transactional.

### Monitor signer ledger capacity

After install/update and from monitoring, run:

```bash
fased wallet signer doctor --json
```

Alert on any failed `state.capacity.*` check. Warnings begin at 80% of the hard
fail-closed limits. Terminal operation details are automatically compacted
after 90 days into permanent SHA-256 request-ID replay tombstones; reserved,
broadcast, and unknown records are never pruned. Do not delete signer database
buckets or restore an older snapshot to make room. Follow the complete
snapshot and stale-restore rules in [Self-hosted Wallet](/plugins/crypto/wallet-self-hosted#typed-operations-and-durable-limits).

## Update support contract

Use this order for every existing installation:

1. Run `fased update`.
2. Confirm the version changed when an update was available and the Gateway RPC
   probe is healthy.
3. If a pre-handoff Local CLI cannot complete the transition, run the normal
   documented Local installer once. If a legacy Hosting root controller is
   absent, run the normal documented Hosting bootstrap once from provider root.
4. Return to `fased update` for every later release.

The bootstrap replaces application/runtime files, not user state. Do not delete
`~/.fased` or `/home/app/.fased`, and do not run fresh onboarding merely to fix
an old updater.

For a recognized pre-handoff Local or WSL installation, use the standard Local
installer:

```bash
curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
  | bash -s -- --local
```

It selects one verified release, preserves user state, skips onboarding, and
establishes the protected supervisor/controller/signer boundary. Then verify:

```bash
hash -r
fased update status
fased update
fased --version
fased doctor
fased gateway restart
fased gateway status
fased plugins doctor
```

The bootstrap refuses unrelated or unsafe state. It does not overwrite an
unrelated user-managed command, delete user data, or rerun onboarding. Explicit
repair remains a separate support operation for a damaged already-protected
boundary and is not the compatibility path.

VPS Hosting bootstrap must run from the provider's root console. Rerun the
public one-command `--hosting` installer; it detects the existing installation,
verifies the immutable release bundle, and selects the internal repair path.
Use the
[manual pre-execution verification procedure](/install/installer#exact-tag-pre-execution-verification)
only when policy requires authenticating `install.sh` before its first shell
executes.

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

If a source checkout is bad, roll back to an earlier release tag, then rerun
the source installer:

```bash
git checkout --detach vX.Y.Z
./install.sh --source-install --no-onboard --release vX.Y.Z
```

Then verify:

```bash
fased doctor
fased status
```

## Current public boundary

Fresh installs and hosted systems should use the curl bootstrap:

- curl bootstrap for supported Linux/systemd Local, Ubuntu WSL2 Local, macOS
  Local, and hosted VPS machines
- `fased update` for normal updates
- verified GitHub Release artifacts for supported Linux/WSL2/macOS Local and
  Linux VPS Hosting installs and updates
- source checkout builds and explicit `--source-install` workflows are
  contributor paths; they are not managed installation evidence
- legacy global npm installs are accepted only as migration inputs; use the
  verified installer for the maintained layout

See [Core And External Components](/install/components) for bundled channels,
local model servers, browser binaries, and local memory embeddings.

## Related

- [Install](/install)
- [Installer internals](/install/installer)
- [CLI `update`](/cli/update)
- [CLI `onboard`](/cli/onboard)
