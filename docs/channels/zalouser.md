---
summary: "Unofficial Zalo personal-account setup through zca-cli, with pairing and group policy notes."
read_when:
  - Setting up Zalo Personal for Fased
  - Debugging Zalo Personal login or message flow
title: "Zalo Personal"
---

# Zalo Personal (unofficial)

This channel is the unofficial fallback when you need Zalo access from a
personal account instead of the official bot platform. Fased drives `zca-cli`,
listens for inbound messages, and keeps the usual DM and group policy model on
top of that automation layer.

Status: experimental. This integration automates a personal Zalo account through `zca-cli`.

> **Warning:** This is an unofficial integration and may result in account
> suspension or ban. Use at your own risk.

## Setup from Agent > Channels

Zalo Personal ships with Fased as a local bundled channel extension. You do not
need to download an npm package in a normal install.

Open **Agents**, select the Agent, then use **Agent > Channels > Zalo
Personal**. Use the QR login flow, save the channel, then restart the gateway if
the UI reports that the runtime still needs to load.

## Prerequisite: zca-cli

The Gateway machine must have the `zca` binary available in `PATH`.

- Verify: `zca --version`
- If missing, install zca-cli. See `extensions/zalouser/README.md` or the
  upstream zca-cli docs.

## Quick setup (beginner)

Treat this as a higher-risk integration. Keep it on a separate personal
account, assume the login can break, and keep access narrow.

1. Login (QR, on the Gateway machine):
   - `fased channels login --channel zalouser`
   - Scan the QR code in the terminal with the Zalo mobile app.
2. Enable the channel in **Agent > Channels > Zalo Personal**:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

3. Restart the Gateway if the UI asks for it.
4. DM access defaults to pairing; approve the pairing code on first contact.

## What it is

- Uses `zca listen` to receive inbound messages.
- Uses `zca msg ...` to send replies (text/media/link).
- Designed for “personal account” use cases where Zalo Bot API is not available.

## Naming

Channel id is `zalouser` to make it explicit this automates a **personal Zalo
user account**. The `zalo` id stays reserved for the official Zalo API path.

## Finding IDs (directory)

Use the directory CLI to discover peers/groups and their IDs:

```bash
fased directory self --channel zalouser
fased directory peers list --channel zalouser --query "name"
fased directory groups list --channel zalouser --query "work"
```

## Limits

- Outbound text is chunked to ~2000 characters (Zalo client limits).
- Streaming is blocked by default.

## Access control (DMs)

`channels.zalouser.dmPolicy` supports `pairing | allowlist | open | disabled`
(default: `pairing`).
`channels.zalouser.allowFrom` accepts user IDs or names. The wizard resolves
names to IDs via `zca friend find` when available.

Approve via:

- `fased pairing list zalouser`
- `fased pairing approve zalouser <code>`

## Group access (optional)

- Default: `channels.zalouser.groupPolicy = "open"` (groups allowed). Use
  `channels.defaults.groupPolicy` to override the default when unset.
- Restrict to an allowlist with:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (keys are group IDs or names)
- Block all groups: `channels.zalouser.groupPolicy = "disabled"`.
- Agent > Channels and CLI setup can prompt for group allowlists.
- On startup, Fased resolves group/user names in allowlists to IDs and logs the
  mapping. Unresolved entries are kept as typed.

Example:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Multi-account

Accounts map to zca profiles. Example:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Troubleshooting

**`zca` not found:**

- Install zca-cli and ensure it’s on `PATH` for the Gateway process.

**Login doesn’t stick:**

- `fased channels status --probe`
- Re-login: `fased channels logout --channel zalouser && fased channels login --channel zalouser`
