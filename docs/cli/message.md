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

Built-in channel names include `whatsapp`, `telegram`, `discord`, `irc`,
`googlechat`, `slack`, `signal`, and `imessage`. Installed channel plugins can
add names such as `mattermost`, `msteams`, `matrix`, and `bluebubbles`.

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

## Action map

| Action                                        | Common channels                                         | Notes                                              |
| --------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `send`                                        | all major chat channels                                 | Text and optional media/reply/thread flags.        |
| `poll`                                        | WhatsApp, Telegram, Discord, Matrix, MS Teams           | Poll options are repeatable.                       |
| `react`                                       | Discord, Google Chat, Slack, Telegram, WhatsApp, Signal | Some channels require author/participant metadata. |
| `reactions`                                   | Discord, Google Chat, Slack                             | List reactions for a message.                      |
| `read`                                        | Discord, Slack                                          | Read recent messages.                              |
| `edit` / `delete`                             | Discord, Slack, Telegram where supported                | Requires message id and target.                    |
| `pin` / `unpin` / `pins`                      | Discord, Slack                                          | Pin management.                                    |
| `permissions`                                 | Discord/Slack where supported                           | Fetch channel permission metadata.                 |
| `search`                                      | Discord                                                 | Search messages by guild/query filters.            |
| `thread create/list/reply`                    | Discord                                                 | Thread operations.                                 |
| `emoji list/upload`                           | Discord, Slack                                          | Upload is Discord-only.                            |
| `sticker send/upload`                         | Discord                                                 | Sticker operations.                                |
| `role`, `channel`, `member`, `voice`, `event` | Discord/Slack where supported                           | Administrative channel helpers.                    |
| `timeout`, `kick`, `ban`                      | Discord                                                 | Moderation helpers.                                |

Run `fased message --help` and `fased message <action> --help` for the current
flags.

## Related

- [Chat Channels](/channels)
- [Channel routing](/channels/channel-routing)
- [Channel troubleshooting](/channels/troubleshooting)
