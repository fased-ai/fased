---
summary: "Telegram bot setup, DM and group policy, and long-polling or webhook behavior."
read_when:
  - Setting up Telegram
  - Debugging Telegram DMs, groups, or bot delivery
title: "Telegram"
---

# Telegram

Telegram is the fastest public bot surface for many Fased setups. The gateway
owns the bot token, receives updates through long polling by default, and keeps
DM and group policy separate.

Status: supported for DMs and groups. Long polling is default; webhook mode is
optional.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Pair unknown DMs before they can talk to the Agent.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Mention gating and group allowlists.
  </Card>
  <Card title="Troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Shared channel diagnostics.
  </Card>
</CardGroup>

## Quick setup

1. In Telegram, open **@BotFather**.
2. Run `/newbot` and save the token.
3. Open **Agents > selected Agent > Channels > Telegram**.
4. Paste the token and keep DM policy on `pairing` to start.
5. Save, start the gateway, and approve the first DM pairing.

Config shape:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: {
        "*": { requireMention: true },
      },
    },
  },
}
```

Telegram does not use `fased channels login telegram`. Configure the token from
**Agent > Channels**, config, or env, then start the gateway.

## Telegram settings

| Setting          | Why it matters                                                       |
| ---------------- | -------------------------------------------------------------------- |
| Privacy mode     | Controls whether the bot can see all group messages.                 |
| Group admin      | Admin bots can receive all group messages when configured that way.  |
| `/setjoingroups` | Allows or denies group adds.                                         |
| `/setprivacy`    | Changes group visibility behavior. Re-add the bot after changing it. |

For most groups, keep mention gating on.

## Access model

| Area          | Recommended start                         |
| ------------- | ----------------------------------------- |
| DMs           | `dmPolicy: "pairing"`                     |
| Groups        | require mention                           |
| Sender access | owner or allowlist first                  |
| Agent routing | explicit route per peer/topic when needed |

## Runtime behavior

- Long polling is the normal local runtime.
- Webhook mode is optional when you have a public HTTPS endpoint.
- Forum topics can route to distinct sessions.
- Task commands create Agent-owned Tasks; Telegram is only the transport and
  optional delivery target.

## Useful commands

```bash
fased gateway
fased channels status telegram
fased pairing list telegram
fased pairing approve telegram <CODE>
fased logs --follow
```

## Troubleshooting

| Symptom                         | Check                                            |
| ------------------------------- | ------------------------------------------------ |
| Bot does not reply in DM        | Pairing code, DM policy, token, gateway logs.    |
| Bot ignores group messages      | Mention requirement, privacy mode, admin status. |
| Topic replies go to wrong place | Use explicit topic routes.                       |
| Webhook conflicts with polling  | Use one update mode at a time.                   |

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Channel troubleshooting](/channels/troubleshooting)
