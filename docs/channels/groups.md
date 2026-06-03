---
summary: "Cross-channel group behavior, gating, and session isolation"
read_when:
  - Changing group chat behavior or mention gating
  - Tuning group allowlists across channels
title: "Groups"
---

# Groups

Fased treats group and room traffic consistently across supported surfaces:

- WhatsApp
- Telegram
- Discord
- Slack
- Signal
- iMessage / BlueBubbles
- Microsoft Teams
- Zalo
- Matrix and other room-style plugins when configured

The transport differs by provider, but the control model is the same:

- who is allowed to trigger the group
- whether a mention is required
- which session key the group uses
- which tools are allowed there

## Fast mental model

Direct messages and groups are not the same thing.

- **DM access**
  - controlled by channel DM policy plus allowlists or pairing
- **group access**
  - controlled by `groupPolicy`, channel-specific allowlists, and sender
    allowlists
- **reply triggering**
  - controlled by mention gating or activation rules

Typical flow:

```text
groupPolicy -> group allowlist -> sender allowlist -> mention / activation -> reply
```

## Beginner version

Default posture:

- groups are fail-closed unless you allow them
- allowed groups still require a mention by default on many surfaces

That means an allowlisted sender in an allowed group can trigger Fased by
mentioning it, while unrelated traffic can still be observed quietly without
causing replies.

For normal setup, open **Agents**, select the Agent, then use **Agent > Channels**
on the relevant channel row. Use raw config only for advanced
multi-account or per-peer policies not exposed in the UI.

## Session keys

Groups and rooms always get their own isolated session keys.

Examples:

- `agent:<agentId>:whatsapp:group:<jid>`
- `agent:<agentId>:telegram:group:<id>`
- `agent:<agentId>:discord:channel:<id>`

Threaded surfaces extend the key:

- Telegram forum topics add `:topic:<threadId>`
- Slack and Discord threads add `:thread:<threadId>`

Important:

- group context is isolated from your main DM session
- heartbeats do not run inside group sessions

## Pattern: DMs on host, groups sandboxed

A common Fased setup is:

- personal DMs in the main session
- public or semi-public groups in sandboxed non-main sessions

Example:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

This keeps group sessions operational but narrower than your private DM lane.

## Display labels

UI labels prefer `displayName` when the provider supplies it.

Conventions:

- rooms and channels may use `#room`
- group-style labels use slugged identifiers like `g-my-group`

## Group policy

Cross-channel pattern:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["123456789"],
      groups: { "*": { requireMention: true } },
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["chat_id:123"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

Policy meanings:

| Policy      | Behavior                                         |
| ----------- | ------------------------------------------------ |
| `open`      | any group may trigger, mention rules still apply |
| `disabled`  | block all group traffic                          |
| `allowlist` | only allowed groups may trigger                  |

Notes:

- `groupPolicy` is separate from mention gating
- WhatsApp, Telegram, Signal, iMessage, Microsoft Teams, and Zalo typically use
  `groupAllowFrom`
- Discord uses `channels.discord.guilds.<id>.channels`
- Slack uses `channels.slack.channels`
- Matrix uses `channels.matrix.groups`
- if the provider block is missing entirely, Fased falls back to fail-closed
  behavior rather than silently opening group access

## Mention gating

Mention gating is usually the recommended default for groups.

Example:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@fased", "fased", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Notes:

- `mentionPatterns` are case-insensitive regexes
- native mention metadata wins when the provider gives it
- reply-to-bot messages can count as implicit mentions on supported surfaces
- history injection is pending-only by default; skipped messages can still be
  kept as context

## Tool restrictions inside groups

Channels can further restrict tools at the group or room level.

Available knobs:

- `tools`
- `toolsBySender`

Resolution order:

1. group or room `toolsBySender`
2. group or room `tools`
3. default `*` `toolsBySender`
4. default `*` `tools`

Example:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "id:123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

These restrictions stack with normal global and agent-level tool policy. Deny
still wins.

## Group allowlist examples

Disable all group replies:

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

Allow only specific WhatsApp groups:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

Allow all groups but require mention:

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Only the owner can trigger in groups:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Activation

Current owner-only activation commands:

- `/activation mention`
- `/activation always`

This is primarily a WhatsApp group control today. Other channel surfaces do not
generally use that command yet.

## Context fields

Common group inbound fields include:

- `ChatType=group`
- `GroupSubject`
- `GroupMembers`
- `WasMentioned`

Telegram forum traffic can also include:

- `MessageThreadId`
- `IsForum`

Fased also prepends a short group intro on the first turn of a new group
session so the model knows it is in a shared space rather than a DM.

## Channel-specific notes

### iMessage

- prefer `chat_id:<id>` when routing or allowlisting
- group replies always go back to the same `chat_id`

### WhatsApp

See [Group Messages](/channels/group-messages) for the WhatsApp-specific runtime
details such as pending-message history injection and activation behavior.
