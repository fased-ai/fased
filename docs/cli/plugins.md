---
summary: "Install, enable, update, or inspect gateway plugins and extensions."
read_when:
  - You want to install or manage in-process gateway plugins
  - You want to debug plugin load failures
title: "plugins"
---

# `fased plugins`

Manage gateway plugins and extensions that load in-process with the runtime.

Related:

- [Plugin system](/tools/plugin)
- [Plugin manifest](/plugins/manifest)
- [Security](/gateway/security)

## Commands

```bash
fased plugins list
fased plugins list --json
fased plugins list --enabled
fased plugins list --verbose
fased plugins info <id>
fased plugins info <id> --json
fased plugins install <path-or-spec>
fased plugins enable <id>
fased plugins disable <id>
fased plugins helpers sessions status [id]
fased plugins helpers sessions status [id] --json
fased plugins helpers sessions enable <id>
fased plugins helpers sessions disable <id>
fased plugins uninstall <id>
fased plugins uninstall <id> --dry-run
fased plugins uninstall <id> --keep-files
fased plugins uninstall <id> --force
fased plugins update <id>
fased plugins update --all
fased plugins update <id> --dry-run
fased plugins update <id> --approve-risky-changes
fased plugins doctor
```

Bundled plugins ship with Fased but start disabled unless a setup path enables
them.

Telegram, WhatsApp, Discord, and Slack are official add-ons rather than bundled
core plugins:

```bash
fased plugins install @fased/telegram
fased plugins install @fased/whatsapp
fased plugins install @fased/discord
fased plugins install @fased/slack
fased gateway restart
```

## Runtime helper grants

Plugins do not receive runtime helper access by default. Grant read-only,
sanitized session metadata access explicitly:

```bash
fased plugins helpers sessions status
fased plugins helpers sessions status <id>
fased plugins helpers sessions enable <id>
fased plugins helpers sessions disable <id>
```

This toggles `plugins.entries.<id>.runtime.helpers.sessions.read`. It does not
enable the plugin itself. Restart the gateway after changing the grant so the
active plugin runtime reloads with the new permission.

## Install

```bash
fased plugins install <path-or-spec>
fased plugins install <npm-spec> --pin
fased plugins install --link ./my-plugin
```

Rules:

- plugin packages must include `fased.plugin.json`
- the manifest must include a valid inline schema
- npm specs are registry-only
- Git and arbitrary remote specs are rejected
- dependency install uses `--ignore-scripts`

Supported local archives:

- `.zip`
- `.tgz`
- `.tar.gz`
- `.tar`

`--link` adds a local directory to `plugins.load.paths` instead of copying it.

`--pin` stores the exact resolved npm version in `plugins.installs`.

## Uninstall

```bash
fased plugins uninstall <id>
fased plugins uninstall <id> --dry-run
fased plugins uninstall <id> --keep-files
fased plugins uninstall <id> --force
```

Normal uninstall removes:

- `plugins.entries`
- `plugins.installs`
- plugin allowlist references
- linked load paths when applicable

By default it also removes the installed plugin directory under:

- `$FASED_STATE_DIR/extensions/<id>`

`--keep-files` leaves those files on disk.

`--keep-config` is a deprecated alias for `--keep-files`.

`--force` skips the uninstall confirmation prompt.

## Update

```bash
fased plugins update <id>
fased plugins update --all
fased plugins update <id> --dry-run
fased plugins update <id> --approve-risky-changes
```

Updates apply to npm-installed plugins tracked in `plugins.installs`.

If a stored integrity hash exists and the fetched artifact no longer matches,
Fased warns before proceeding.

Use `--approve-risky-changes` only after reviewing source, dependency/script, or
permission-surface changes.
