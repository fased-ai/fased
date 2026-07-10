---
summary: "Tlon and Urbit ship setup, channel discovery, and Fased DM or group policy."
read_when:
  - Working on Tlon/Urbit channel features
title: "Tlon"
---

# Tlon

Tlon gives Fased an Urbit-native chat surface without a separate hosted
backend. The plugin connects to your ship, handles DMs and group channels, and
keeps the same allowlist and mention gates that the rest of the gateway uses.

Status: source extension for DMs, group mentions, thread replies, and
text-plus-URL media fallback. Reactions, polls, and native media uploads are not
supported.

## Setup from Agent > Channels

Tlon is available from a source install. The lightweight hosted runtime does
not currently include its Urbit runtime dependency, and Tlon does not yet have
an official Fased add-on package. Use a maintained source install for this
channel.

Open **Agents**, select the Agent, then use **Agent > Channels > Tlon**. Enter
the ship URL and login code, save the channel, then restart the gateway if the
UI reports that the runtime still needs to load.

## Setup

You need one ship URL plus a valid ship login code. After that, choose
auto-discovered group channels or an explicit allowlist.

1. Gather your ship URL and login code.
2. Configure **Agent > Channels > Tlon**.
3. Restart the gateway if the UI asks for it.
4. DM the bot or mention it in a group channel.

Minimal config (single account):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

Private/LAN ship URLs (advanced):

By default, Fased blocks private/internal hostnames and IP ranges for this
plugin as SSRF hardening. If your ship URL is on a private network, explicitly
opt in:

```json5
{
  channels: {
    tlon: {
      allowPrivateNetwork: true,
    },
  },
}
```

## Group channels

Auto-discovery is enabled by default. You can also pin channels manually:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Disable auto-discovery:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Access control

DM allowlist for production:

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

The current runtime treats an empty `dmAllowlist` as an open DM lane. Set
explicit ships before using the bot beyond a private test.

Group authorization (restricted by default):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Delivery targets (CLI/cron)

Use these with `fased message send` or cron delivery:

- DM: `~sampel-palnet` or `dm/~sampel-palnet`
- Group: `chat/~host-ship/channel` or `group:~host-ship/channel`

## Notes

- Group replies require a mention (e.g. `~your-bot-ship`) to respond.
- Thread replies: if the inbound message is in a thread, Fased replies in-thread.
- Media: `sendMedia` falls back to text + URL (no native upload).
