---
summary: "Inspect and manage global lifecycle hook packs and bundled hook helpers."
read_when:
  - You want to manage lifecycle hooks
  - You want to install or update hooks
title: "hooks"
---

# `fased hooks`

Manage local lifecycle hooks from the CLI.

Browser equivalent: **Extensions > Hooks**. Agent memory controls live in
**Agent > Memory**.

Related:

- [Hooks](/automation/hooks)
- [Plugins](/tools/plugin#plugin-hooks)

## Inspect hooks

```bash
fased hooks list
fased hooks list --eligible
fased hooks list --verbose
fased hooks list --json
fased hooks info session-memory
fased hooks check
```

`list` shows discovered hooks from workspace, managed, and bundled sources.
`check` summarizes eligibility.

## Enable or disable

```bash
fased hooks enable session-memory
fased hooks disable command-logger
```

Restart the gateway after changing enabled hook code if the UI or CLI says the
runtime has not reloaded.

Plugin-owned hooks may show as `plugin:<id>`. Enable or disable the plugin
instead of editing those hooks directly.

## Install hook packs

```bash
fased hooks install ./my-hook-pack
fased hooks install ./my-hook-pack.zip
fased hooks install @fased/my-hook-pack
fased hooks install -l ./my-hook-pack
fased hooks install @fased/my-hook-pack --pin
```

Rules:

- npm specs are registry-only
- local folders and archives are supported for operator-controlled installs
- Git, URL, and arbitrary remote specs are rejected
- dependency installs run with `--ignore-scripts`
- `--pin` records npm installs as an exact resolved package version

Update npm-backed hook packs:

```bash
fased hooks update <id>
fased hooks update --all
fased hooks update --all --dry-run
```

## Bundled hooks

| Hook                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `session-memory`        | Saves session context to memory when `/new` or `/reset` runs. |
| `bootstrap-extra-files` | Adds extra workspace files during Agent bootstrap.            |
| `command-logger`        | Writes command events to `~/.fased/logs/commands.log`.        |
| `boot-md`               | Runs `BOOT.md` when the gateway starts.                       |

## Review rule

Hooks are executable code inside the gateway. Review hook source and dependency
trees before enabling third-party hook packs.
