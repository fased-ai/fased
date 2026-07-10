---
summary: "Slack app setup, Socket Mode or HTTP mode, and Fased DM and channel policy."
read_when:
  - Setting up Slack
  - Debugging Slack socket mode, HTTP mode, commands, or delivery
title: "Slack"
---

# Slack

Slack connects Fased to a hosted workspace through a Slack app. Fased supports
Socket Mode and HTTP Events API mode, then applies the same pairing, allowlist,
mention, and task ownership rules as other channels.

Status: supported for DMs and channels. Socket Mode is the recommended default.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    DMs can start in pairing mode.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Channel mention and sender policy.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Command behavior and catalog.
  </Card>
</CardGroup>

## Quick setup

Socket Mode avoids public inbound exposure.

1. Open **Agents > selected Agent > Channels > Slack** and click **Install**.
   Restart the Gateway when prompted.
2. Create a Slack app.
3. Enable Socket Mode.
4. Create an App Token with `connections:write`.
5. Install the app and copy the Bot Token.
6. Subscribe to message, mention, reaction, and membership events you need.
7. Return to **Agent > Channels > Slack**.
8. Paste App Token and Bot Token, choose Socket Mode, and save.

CLI install:

```bash
fased plugins install @fased/slack
fased gateway restart
```

Config shape:

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
  },
}
```

HTTP mode is available when you have a public HTTPS endpoint and Slack Signing
Secret configured.

## Slack app checklist

Typical bot events:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`
- `reaction_added`
- `reaction_removed`

Also enable App Home messages if you want Slack DMs.

## Access model

| Area     | Recommended start                                   |
| -------- | --------------------------------------------------- |
| DMs      | pairing                                             |
| Channels | allowlist plus mention requirement                  |
| Commands | owner or allowlist first                            |
| Routes   | explicit Agent route per channel/thread when needed |

## Runtime behavior

- Socket Mode keeps a private outbound connection to Slack.
- HTTP mode accepts Slack events at the configured endpoint.
- Threads keep route/session context.
- Slash commands share the normal command authorization path.
- Task commands create Agent-owned Tasks.

## Troubleshooting

| Symptom                 | Check                                                       |
| ----------------------- | ----------------------------------------------------------- |
| No events arrive        | Socket Mode, App Token, event subscriptions, app installed. |
| DMs missing             | App Home messages tab and `message.im` event.               |
| Channel replies ignored | Mention requirement, group policy, bot channel membership.  |
| HTTP mode fails         | signing secret, request URL, public HTTPS endpoint.         |
| Slash commands missing  | command request URL and app reinstall.                      |

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Troubleshooting](/channels/troubleshooting)
