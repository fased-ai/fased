---
summary: "CLI reference for `fased update` (repo-backed update plus optional gateway restart)"
read_when:
  - You want to update a source checkout safely
  - You need to understand `--update` shorthand behavior
title: "update"
---

# `fased update`

Update a repo checkout of Fased and optionally switch channels.

For local installs, run it from the Fased install directory, usually `~/fased`:

```bash
cd ~/fased
fased update status
fased update
```

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

After hosted onboarding, SSH as `app` should open directly in `/home/app/fased`.
If it does not, fix the hosted login/shell setup before updating.

Root is only for first bootstrap or emergency repair after hosted hardening.

For normal VPS hosting, install with the hosted installer, not a direct global
npm install:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --hosting
```

Manual `npm install -g @fased/fased` is an advanced local/dev or self-managed
host path for users who already know how to secure the service user, firewall,
dashboard access, and recovery flow.

## Installer refresh is different

`fased update` is the normal stable app update.

`install.sh --hosting` is a hosted bootstrap/repair path. It can refresh more
than the app version:

- when run through the remote curl/bootstrap path, an existing `~/fased`
  checkout is pulled from `origin main`
- when run from a local checkout, the installer can fetch and fast-forward the
  current branch unless `--no-git-update` is used
- hosted mode normally installs/refreshes the prebuilt runtime package from
  `@fased/fased@latest`
- hosted mode can use the source checkout instead when
  `FASED_HOSTING_SOURCE_INSTALL=1` is set
- it can repair hosted service files, Tailscale/private access, sudoers, and
  daemon setup

Use `install.sh --hosting` for first VPS setup or hosted repair. Use
`fased update` for normal stable app releases.

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

High-level flow:

1. require a clean worktree
2. switch to the selected channel or tag
3. fetch upstream when needed
4. for `dev`, preflight the latest `origin/main` commit before rebasing
5. install dependencies
6. rebuild runtime and browser UI assets
7. run `fased doctor`
8. sync installed plugins
9. restart the gateway unless `--no-restart` is set

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

On a hosted VPS, run that direct development flow as `app` from
`/home/app/fased` and use `./install.sh --hosting`.

The browser Control UI shows update state under **Advanced -> Debug -> Update
Status**. Current UI behavior is status-only: it can show version, channel,
install source, package/git state, and dependency state. Use the CLI commands
above to actually update.

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
- [`fased doctor`](/cli/doctor)
