---
summary: "WhatsApp-specific group handling, mention activation, and group sessions"
read_when:
  - Changing WhatsApp group reply behavior
  - Tuning mention patterns or activation rules
title: "Group Messages"
---

# Group messages

This page covers WhatsApp-specific group behavior. The broader cross-channel
model lives in [Groups](/channels/groups).

Goal:

- let Fased sit in WhatsApp groups
- wake it only when appropriate
- keep each group separate from the personal DM session

For normal setup, open **Agents**, select the Agent, then use the WhatsApp row
in **Agent > Channels**. Configure group policy, allowlists, and mention
requirements there before dropping to raw config.

## Core behavior

WhatsApp group handling is built around:

- mention or activation gating
- separate per-group sessions
- pending-message context injection
- sender labeling for the triggered reply

## What is implemented

- activation modes:
  - `mention` (default)
  - `always`
- mention detection through:
  - real WhatsApp mentions
  - configured `mentionPatterns`
  - the bot E.164 as fallback
- `channels.whatsapp.groupPolicy`
  - `open`
  - `disabled`
  - `allowlist`
- per-group session isolation:
  - `agent:<agentId>:whatsapp:group:<jid>`
- pending-only context injection for skipped group messages
- sender suffixing so the agent can see who actually triggered the run
- ephemeral and view-once content unwrapping before mention extraction
- first-turn group prompt hinting

Heartbeats are skipped for WhatsApp group sessions by design.

## Config example

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?fased", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Notes:

- `mentionPatterns` are case-insensitive regexes
- real WhatsApp mentions via `mentionedJids` still win when present
- the regex fallback is mainly there for stripped display-name or number pings

## Activation commands

Owner-only group commands:

- `/activation mention`
- `/activation always`

`/status` in the group will show the current activation mode.

Other channel surfaces currently ignore `/activation`.

## How it behaves at runtime

1. the message lands in a WhatsApp group
2. group policy and sender allowlists are checked
3. mention or activation gating is evaluated
4. if the message should not trigger, it can still be kept as pending context
5. if the message should trigger, Fased runs against that group's isolated
   session

The personal DM session stays untouched.

## Testing

Manual smoke:

- send an `@fased` message in the group
- verify a reply appears
- verify the reply can identify the triggering sender
- send another triggering message and confirm recent skipped lines are present
  as context

Useful logs:

- verbose gateway logs should show the WhatsApp group JID
- session storage should show `agent:<agentId>:whatsapp:group:<jid>` once the
  group has actually triggered a run

## Known considerations

- heartbeats do not run in group sessions
- repeated identical silent messages can be coalesced by echo suppression
- typing indicators follow the configured typing mode
