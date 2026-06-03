---
summary: "CLI reference for `fased update` (repo-backed update plus optional gateway restart)"
read_when:
  - You want to update a source checkout safely
  - You need to understand `--update` shorthand behavior
title: "update"
---

# `fased update`

Update a repo checkout of Fased and optionally switch channels.

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
fased update --yes
fased --update
```

On hosted VPS installs where you SSH in as `root`, run update as the app user:

```bash
sudo -iu app fased update status
sudo -iu app fased update
```

## Options

- `--no-restart`
- `--channel <stable|beta|dev>`
- `--tag <tag|version>`
- `--dry-run`
- `--json`
- `--timeout <seconds>`
- `--yes`

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
4. for `dev`, preflight a clean build path before rebasing
5. install dependencies
6. rebuild runtime and browser UI assets
7. run `fased doctor`
8. sync installed plugins
9. restart the gateway unless `--no-restart` is set

Current channel behavior:

- `stable`
  - latest stable tag
- `beta`
  - latest beta tag
- `dev`
  - `main` plus fetch and rebase flow

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
