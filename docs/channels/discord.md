---
summary: "Discord bot setup for DMs, servers, pairing, and mention-gated routing."
read_when:
  - Setting up Discord
  - Debugging Discord DMs, servers, commands, or routing
title: "Discord"
---

# Discord

Discord connects Fased through the official Discord bot APIs. Use it when you
want a public bot identity, DMs, server channels, slash commands, and
mention-gated team routing.

Status: supported for DMs and guild channels.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    DMs start with pairing unless you choose another policy.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Group policy, mentions, and sender controls.
  </Card>
  <Card title="Troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel checks and repair steps.
  </Card>
</CardGroup>

## Quick setup

1. Create a Discord application in the Discord Developer Portal.
2. Add a Bot user.
3. Enable **Message Content Intent**. Enable **Server Members Intent** only if
   you need role allowlists or name-to-ID matching.
4. Invite the bot with `bot` and `applications.commands` scopes.
5. Open **Agents > selected Agent > Channels > Discord**.
6. Paste the bot token, server id, and owner/user id.
7. Save, start or restart the gateway, then pair the first DM if using pairing.

Scripted setup can use config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "DISCORD_BOT_TOKEN",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      requireMention: true,
    },
  },
}
```

Do not paste bot tokens into Chat or channel messages. Store them from
**Agent > Channels**, config, or secrets.

## Access model

| Area          | Recommended start                                            |
| ------------- | ------------------------------------------------------------ |
| DMs           | `dmPolicy: "pairing"`                                        |
| Servers       | `groupPolicy: "allowlist"`                                   |
| Mentions      | required in shared channels                                  |
| Commands      | owner or allowlist first                                     |
| Agent routing | route server/channel/thread to the selected Agent explicitly |

Discord servers should start narrow: one private test server, one allowed user,
and mention-gated channels. Widen access after the route and command policy are
working.

## Runtime behavior

- DMs and guild messages route into Agent sessions.
- Threads and forum channels keep their own session shape.
- Slash commands use the same command authorization path as other channels.
- Task commands create Agent-owned Tasks; Discord does not own the task.
- Delivery can return to the same channel/thread or an explicit target.

## Useful commands

```bash
fased gateway
fased channels status discord
fased pairing list discord
fased pairing approve discord <CODE>
fased logs --follow
```

## Troubleshooting

| Symptom                 | Check                                                        |
| ----------------------- | ------------------------------------------------------------ |
| Bot sees no messages    | Message Content Intent, invite scopes, channel permissions.  |
| DMs do not work         | Server privacy setting, pairing state, DM policy.            |
| Server messages ignored | Group policy, mention requirement, allowlists.               |
| Slash commands missing  | `applications.commands` scope and command registration logs. |
| Role routing fails      | Server Members Intent and stable role/user ids.              |

See [Channel Troubleshooting](/channels/troubleshooting) for the shared command
ladder.

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Slash commands](/tools/slash-commands)
