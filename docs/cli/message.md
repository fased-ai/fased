---
summary: "Send outbound messages or run channel-specific actions from one CLI surface."
read_when:
  - Sending channel messages from scripts
  - Testing channel delivery
  - Running channel-specific message actions
title: "message"
---

# `fased message`

Use `fased message` for outbound sends and channel-specific message actions.

```bash
fased message <subcommand> [flags]
```

## Shared flags

| Flag                  | Meaning                                          |
| --------------------- | ------------------------------------------------ |
| `--channel <name>`    | Channel to use when more than one is configured. |
| `--account <id>`      | Named channel account.                           |
| `--target <dest>`     | Destination user/channel/thread.                 |
| `--targets <dest...>` | Broadcast destinations (`broadcast` only).       |
| `--json`              | Machine-readable output.                         |
| `--dry-run`           | Preview without sending where supported.         |
| `--verbose`           | More diagnostic output.                          |

Channel names come from the active channel plugin registry. Core channels
include `telegram`, `whatsapp`, `discord`, `irc`, `googlechat`, `slack`,
`signal`, and `imessage`. A configured install can also expose bundled or
external channels such as `mattermost`, `msteams`, `matrix`, `bluebubbles`,
`line`, `zalo`, `nostr`, `tlon`, and `twitch`.

## Target formats

| Channel     | Target examples                               |
| ----------- | --------------------------------------------- |
| WhatsApp    | E.164 phone number or group JID               |
| Telegram    | chat id, forum topic, or `@username`          |
| Discord     | `channel:<id>`, `user:<id>`, thread id        |
| Google Chat | `spaces/<spaceId>` or `users/<userId>`        |
| Slack       | `channel:<id>` or `user:<id>`                 |
| Mattermost  | `channel:<id>`, `user:<id>`, or `@username`   |
| Signal      | `+E.164`, `group:<id>`, `username:<name>`     |
| iMessage    | handle, `chat_id:<id>`, or `chat_guid:<guid>` |
| IRC         | nick or `#channel`                            |
| MS Teams    | conversation id or `user:<aad-object-id>`     |

Where supported, names such as `#help` can resolve through the directory cache.

## Common actions

```bash
fased message send --channel discord --target channel:123 --message "hi"
fased message poll --channel telegram --target @mychat --poll-question "Lunch?" --poll-option Pizza --poll-option Sushi
fased message react --channel slack --target channel:C123 --message-id 123.456 --emoji thumbs_up
fased message read --channel discord --target channel:123 --limit 20
fased message broadcast --channel all --targets telegram:123 slack:C123 --message "Update"
```

## Common action groups

Core delivery:

- `send`: send text and optional media/reply/thread fields.
- `broadcast`: send one message to several targets.
- `poll`: create a poll where the channel supports polls.

Message management:

- `react` and `reactions`: add or inspect reactions.
- `read`: read recent messages from channels that support reads.
- `edit` and `delete`: update or remove a message by id.
- `pin`, `unpin`, and `pins`: manage pinned messages.

Thread and search helpers:

- `thread create`, `thread list`, and `thread reply`: Discord-style thread
  operations.
- `permissions`: inspect channel permission metadata.
- `search`: search messages by provider-supported filters.

Community admin helpers:

- `emoji list` and `emoji upload`: emoji management.
- `sticker send` and `sticker upload`: sticker actions.
- `role`, `channel`, `member`, `voice`, and `event`: Discord/Slack-style
  administrative helpers.
- `timeout`, `kick`, and `ban`: Discord moderation helpers.

Plugins can expose extra action names behind the same channel capability
surface. The CLI subcommands above cover the common operator actions.

Run `fased message --help` and `fased message <action> --help` for the current
flags.

## Related

- [Chat Channels](/channels)
- [Channel routing](/channels/channel-routing)
- [Channel troubleshooting](/channels/troubleshooting)
