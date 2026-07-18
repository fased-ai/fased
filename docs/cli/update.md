---
summary: "CLI reference for local, hosted-artifact, and package-manager updates."
read_when:
  - You want to update a source checkout safely
  - You need to understand `--update` shorthand behavior
title: "update"
---

# `fased update`

Update an installed Fased runtime and optionally switch channels.

On supported packaged Linux installs, a stable updater outside the versioned
application verifies and activates the exact release artifact. It then restarts
the correct Gateway service and checks health. VPS Hosting uses the
root-managed system service; Local Linux uses the user service. If the new
packaged runtime does not become healthy, Fased restores the previous runtime
automatically.

For managed Linux Local and WSL installs, it works from any directory:

```bash
fased update status
fased update
```

Source/developer checkouts should run it from the checkout.

<Note>
`fased onboard --install-daemon` installs or reconfigures the runtime service.
It is not the primary version-update path.
</Note>

## Usage

```bash
fased update
fased update status
fased update wizard
fased update --channel beta
fased update --channel dev
fased update --tag beta
fased update --dry-run
fased update --no-restart
fased update --channel dev --safe-fallback
fased update --yes
fased --update
```

On hosted VPS installs, normal updates run as the `app` user over Tailscale:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

When the installed version already matches the selected release, the command
prints `Already current: <version>` and exits without downloading, swapping the
runtime, updating plugins, or restarting the service.

After hosted onboarding, SSH as `app` should open directly in `/home/app/fased`.
If it does not, fix the hosted login/shell setup before updating.

Root is only for first bootstrap or emergency repair after hosted hardening.

For normal VPS hosting, install with the hosted installer, not a direct global
npm install:

Use the [one-command Hosting installer](/install/vps) from the provider root
console. For an existing broken installation, use the exact-tag manual
attestation procedure and run the verified local asset with `--repair-hosting`.

Manual `npm install -g @fased/fased` is an advanced local/dev or self-managed
host path for users who already know how to secure the service user, firewall,
dashboard access, and recovery flow.

## Installer refresh is different

`fased update` is the normal stable app update.

`install.sh --hosting --release vX.Y.Z` is a provider-console bootstrap/repair
path. It can refresh more than the app version:

- it verifies the exact tagged architecture-specific hosted app artifact and
  GitHub/Sigstore attestation before privileged assets are loaded
- it installs the fixed root-owned Gateway/signer units and host prerequisites
- it keeps the `app` account out of sudo and exposes no general root control socket
- it refuses privileged `--source-install` and app-owned/Git checkout sources

Use `install.sh --hosting` for first VPS setup or hosted repair. Use
`fased update` for normal stable app releases.

An already-installed legacy updater that cannot replace itself requires the
one-time Local/WSL or Hosting bootstrap documented in
[Updating](/install/updating#update-support-contract). Local and WSL use
`--repair-local`; VPS Hosting uses `--repair-hosting` from the provider's
root recovery console. After that bootstrap, normal updates use `fased update`
alone.

## Options

- `--no-restart`
- `--channel <stable|beta|dev>`
- `--tag <tag|version>`
- `--dry-run`
- `--json`
- `--timeout <seconds>`
- `--yes`
- `--safe-fallback` dev channel only; try older `main` commits when the latest
  commit fails preflight

Downgrades require confirmation because older versions can break the current
config or runtime state.

Managed runtime changes cannot use `--no-restart`: activation succeeds only
after the correct service restarts and reports the target runtime identity.
Same-version checks remain mutation-free when the files and Gateway are
already healthy.

## `update status`

Shows:

- active update channel
- tag or branch
- git SHA when relevant
- update availability

```bash
fased update status
fased update status --json
```

## `update wizard`

Interactive flow to:

- choose a channel
- confirm whether the gateway should restart
- help create a checkout if you select `dev` without a repo checkout

## What it does

The exact path depends on the install:

- **Managed Linux Local and VPS Hosting:** resolve the exact target online,
  download architecture-matched application/dependency layers, verify checksums
  and archive paths, smoke-test before activation, atomically switch the active
  runtime, and verify the service, Gateway version, and plugins. A failed
  candidate rolls back automatically. Normal managed updates never reconcile
  the full npm dependency graph.
- **Local source checkout:** require a clean worktree, select the release tag or
  branch, refresh dependencies, rebuild runtime and Control UI assets, run
  doctor checks, sync plugins, and restart when requested.
- **Manual package install:** update through the detected package manager, sync
  plugins, and restart when requested.

Current channel behavior:

- `stable`
  - default for end users
  - latest stable release tag on git checkouts
  - npm `latest` when package installs are enabled
- `beta`
  - latest beta tag
- `dev`
  - developer channel
  - latest `origin/main` only by default
  - use `--safe-fallback` only for repair/debug sessions that should try older
    candidate commits if the latest commit fails preflight

`fased update` without `--channel dev` does not pull every commit from `main`.
If you need latest development fixes from a repo checkout, use:

```bash
fased update --channel dev
```

Or update the checkout directly during development:

```bash
git checkout main
git pull --ff-only origin main
./install.sh
```

Do not use that direct development flow for maintained VPS Hosting. Privileged
Hosting refuses source/app checkouts; use the exact tagged provider-console
command or a disposable self-managed development host.

The browser Control UI shows update state under **Advanced > Debug > Update
Status**. Current UI behavior is status-only: it can show version, channel,
install source, package or Git state, and dependency state. Use the CLI commands
above to update.

## `--update` shorthand

```bash
fased --update
```

This is just shorthand for:

```bash
fased update
```

## Related

- [Updating](/install/updating)
- [Development channels](/install/development-channels)
- [Control UI layout](/web/control-ui)
- [Core And Optional Components](/install/components)
- [`fased doctor`](/cli/doctor)
