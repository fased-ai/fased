---
summary: "Run health checks and guided repair suggestions for the gateway, config, and channels."
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "doctor"
---

# `fased doctor`

Run health checks and guided repair suggestions for the gateway, config, local state, and configured channels.

Browser equivalent: use focused pages first, then **Logs** and **Advanced >
Debug** for operator diagnostics. Memory repair preview and execution boundaries
are documented under Memory Doctor.

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)
- Diagnostics: [Diagnostics](/diagnostics/index)
- Memory Doctor: [Memory Doctor](/concepts/memory-doctor)

## Examples

```bash
fased doctor
fased doctor --repair
fased doctor --fix
fased doctor --non-interactive
fased doctor --generate-gateway-token
fased doctor --deep
```

## Options

- `--repair`: apply recommended repairs without prompting.
- `--fix`: alias for `--repair`.
- `--force`: apply aggressive repairs that may overwrite custom service config.
- `--yes`: accept defaults without prompting.
- `--non-interactive`: run without prompts; safe migrations only.
- `--generate-gateway-token`: generate and configure a gateway token.
- `--no-workspace-suggestions`: disable workspace memory suggestions.
- `--deep`: scan system services for extra gateway installs.

Notes:

- Interactive prompts, such as keychain/OAuth fixes, only run when stdin is a
  TTY and `--non-interactive` is **not** set. Headless runs skip prompts.
- `--fix` is an alias for `--repair`. It writes a backup to
  `~/.fased/fased.json.bak` and lists each unknown config key it removes.
- State integrity checks detect orphan transcript files in the sessions
  directory and can archive them as `.deleted.<timestamp>`.
- Doctor includes a memory-search readiness check and can recommend
  `fased configure --section model` when embedding credentials are missing.
- If sandbox mode is enabled but Docker is unavailable, doctor reports a direct
  remediation: install Docker or set `agents.defaults.sandbox.mode` to `off`.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv FASED_GATEWAY_TOKEN ...` or
`...PASSWORD`, that value overrides your config file and can cause persistent
“unauthorized” errors.

```bash
launchctl getenv FASED_GATEWAY_TOKEN
launchctl getenv FASED_GATEWAY_PASSWORD

launchctl unsetenv FASED_GATEWAY_TOKEN
launchctl unsetenv FASED_GATEWAY_PASSWORD
```
