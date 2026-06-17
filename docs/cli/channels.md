---
summary: "Manage channel accounts, logins, runtime status, probes, and channel-specific logs."
read_when:
  - You want to add or remove channel accounts
  - You want channel-level status, capability probes, or provider logs
title: "channels"
---

# `fased channels`

Manage channel accounts and inspect their live runtime state from the terminal.
This is the command surface for account setup, login flows, status probes,
provider capabilities, and provider-specific logs.

Browser equivalent: **Agent > Channels**. That is the normal place to set up
accounts, QR/login flows, credentials, route assignment, and delivery targets
for a selected Agent. The CLI is useful for scripts, headless setup, and
provider-specific diagnostics.

Related docs:

- [Channels](/channels/index)
- [Channel Routing](/channels/channel-routing)
- [Diagnostics](/diagnostics/index)

## Common commands

```bash
fased channels list
fased channels status
fased channels capabilities
fased channels capabilities --channel discord --target channel:123
fased channels resolve --channel slack "#general" "@jane"
fased channels logs --channel all
```

`fased channels status` reports both configured channel runtime state and
installable channel catalog entries. Installable entries show whether they came
from the bundled official catalog or an external catalog, and whether the
catalog entry is integrity pinned before install.

## Add and remove accounts

```bash
fased channels add --channel telegram --token-file ~/.fased/secrets/telegram.token
fased channels remove --channel telegram --delete
```

`fased channels add --help` shows channel-specific flags such as:

- bot tokens
- app tokens
- webhook settings
- `signal-cli` paths
- account ids

Credential flags such as `--token`, `--bot-token`, `--app-token`,
`--access-token`, and `--password` can be visible in local process listings or
shell history. Prefer the browser setup flow or file/env-backed options when a
provider supports them.

Interactive add can also:

- prompt for account ids and display names
- offer to bind configured accounts to agents immediately

That binding flow writes account-scoped routing bindings. You can also manage
those later through [`fased agents`](/cli/agents).

## Multi-account migration behavior

If you add a non-default account to a channel that still uses single-account
top-level config, Fased moves account-scoped values into:

- `channels.<channel>.accounts.default`

Then it writes the new account.

This preserves behavior while moving the config to the multi-account shape.

Rules:

- existing channel-only bindings still match the default account
- non-interactive `channels add` does not auto-rewrite unrelated bindings
- if the config is in a mixed old/new shape, `fased doctor --fix` is the repair
  path

## Login and logout

```bash
fased channels login --channel whatsapp
fased channels logout --channel whatsapp
```

Use this for interactive auth flows such as QR-based or browser-assisted
channel setup.

## Capability probe

```bash
fased channels capabilities
fased channels capabilities --channel discord --target channel:123
```

What it surfaces depends on the provider:

- intents
- scopes
- webhook status
- static supported features
- provider-specific diagnostics

## Resolve names to ids

```bash
fased channels resolve --channel slack "#general" "@jane"
fased channels resolve --channel discord "My Server/#support" "@someone"
fased channels resolve --channel matrix "Project Room"
```

Useful options:

- `--kind user|group|auto`

Resolution prefers active matches when several entries share the same name.

## Troubleshooting

- `fased status --deep`
- `fased doctor`
- `fased channels status`
- `fased channels logs --channel <id>`
- Browser: **Agent > Channels** for route/account state, then **Logs** for
  channel logs and **Advanced > Debug** for raw runtime snapshots.

One current caveat:

- some provider usage snapshots can require extra auth scopes
- if a list or status path reports usage-scope problems, use `--no-usage` where
  supported or refresh provider auth
