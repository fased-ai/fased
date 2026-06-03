---
summary: "Send polls through the gateway, CLI, or message tool"
read_when:
  - Sending polls from the CLI
  - Wiring poll support into the gateway or agent tools
title: "Polls"
---

# Polls

Fased can send lightweight polls through the gateway. This is a delivery
feature, not a general workflow engine, so channel behavior depends on what the
target surface actually supports.

## Supported channels

- WhatsApp web
- Telegram
- Discord
- Microsoft Teams via Adaptive Cards

Before sending a poll, connect the channel account in **Agents > Channels** and
make sure the target account, group, channel, or conversation can receive normal
messages from Fased.

## CLI

```bash
# WhatsApp
fased message poll --target +15555550123 \
  --poll-question "Lunch today?" \
  --poll-option "Yes" \
  --poll-option "No" \
  --poll-option "Maybe"

fased message poll --target 123456789@g.us \
  --poll-question "Meeting time?" \
  --poll-option "10am" \
  --poll-option "2pm" \
  --poll-option "4pm" \
  --poll-multi

# Telegram
fased message poll --channel telegram --target -1001234567890 \
  --poll-question "Deploy now?" \
  --poll-option "Yes" \
  --poll-option "No" \
  --poll-duration-seconds 60 \
  --poll-public

# Discord
fased message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" \
  --poll-option "Pizza" \
  --poll-option "Sushi"

fased message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" \
  --poll-option "A" \
  --poll-option "B" \
  --poll-duration-hours 48

# Microsoft Teams
fased message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option "Pizza" \
  --poll-option "Sushi"
```

Common flags:

- `--channel`: `whatsapp` (default), `telegram`, `discord`, or `msteams`
- `--poll-multi`: allow more than one selection
- `--poll-duration-hours`: Discord only, defaults to `24`
- `--poll-duration-seconds`: Telegram only, 5-600 seconds
- `--poll-anonymous` / `--poll-public`: Telegram only

## Gateway RPC

Method: `poll`

Params:

- `to` (string, required)
- `question` (string, required)
- `options` (string[], required)
- `maxSelections` (number, optional)
- `durationHours` (number, optional)
- `durationSeconds` (number, optional, Telegram only)
- `isAnonymous` (boolean, optional, Telegram only)
- `silent` (boolean, optional)
- `threadId` (string, optional)
- `channel` (string, optional, default `whatsapp`)
- `accountId` (string, optional)
- `idempotencyKey` (string, required)

## Agent tool

Use the `message` tool with `action: "poll"`.

Supported fields:

- `to`
- `pollQuestion`
- `pollOption`
- `pollMulti` (optional)
- `pollDurationHours` (optional)
- `pollDurationSeconds` (optional)
- `pollAnonymous` / `pollPublic` (optional)
- `silent` (optional)
- `threadId` (optional)
- `channel` (optional)

## Channel differences

- **WhatsApp**
  - 2 to 12 options
  - `maxSelections` must stay within the option count
  - ignores `durationHours`
- **Telegram**
  - 2 to 10 options
  - `durationSeconds` must be 5 to 600
  - polls are anonymous by default unless `--poll-public` is set
- **Discord**
  - 2 to 10 options
  - `durationHours` is clamped to `1` to `768`
  - `maxSelections > 1` becomes multi-select, but Discord has no strict "pick
    exactly N" mode
- **Microsoft Teams**
  - requires the loaded Teams channel plugin to expose poll support
  - `durationHours` is ignored
  - behavior depends on the Teams adapter that is enabled at runtime

## Operational notes

- Polls are outbound only; channel-specific vote storage and follow-up handling
  stay with the gateway.
- Teams polls depend on the installed Teams adapter, so keep that route for
  controlled, gateway-managed workflows instead of public/high-scale distribution.
