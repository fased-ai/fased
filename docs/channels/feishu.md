---
summary: "Feishu and Lark bot setup, credentials, long-connection events, and Fased gateway wiring."
read_when:
  - Setting up Feishu or Lark
  - Debugging Feishu channel credentials or delivery
title: Feishu
---

# Feishu

**Delivery:** Bundled.

Use Feishu when your team already works in Feishu or Lark and you want Fased to
join those conversations through the platform's bot APIs.

Status: the signed Fased generation includes the Feishu/Lark integration.
Enable it from **Agent > Channels** or onboarding before entering credentials.

It supports the common bot flow, account-aware config, pairing, and group
controls.

## Setup from Agent > Channels

Open **Agents**, select the Agent, then use **Agent > Channels > Feishu**.

You need:

- App ID
- App Secret
- domain: `feishu` or `lark`
- event subscription enabled in the platform console
- bot capability enabled and published/available to the workspace

Restart the gateway if the UI reports that the runtime still needs to load.

## Quick setup

1. Create an enterprise app in Feishu Open Platform or Lark Developer Console.
2. Copy App ID and App Secret.
3. Enable bot capability.
4. Configure event subscription for message events.
5. Publish or make the app available to the workspace.
6. Save credentials in **Agent > Channels > Feishu**.
7. Start or restart the gateway and send a test message.

Config shape:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      appId: "cli_xxx",
      appSecret: "secret", // pragma: allowlist secret
      domain: "feishu",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
  },
}
```

Lark tenants should use `domain: "lark"`.

## Permissions

Enable only the permissions your bot flow needs. Typical needs:

- receive messages
- send messages
- bot menu or bot capability where required
- user/chat id lookup if you want allowlist resolution

Keep app secrets private and rotate them if exposed.

## Access model

| Area          | Recommended start                                |
| ------------- | ------------------------------------------------ |
| DMs           | pairing or allowlist                             |
| Groups        | allowlist plus mention gating                    |
| IDs           | use stable user/chat ids where possible          |
| Multi-account | configure distinct account names and credentials |

## Runtime behavior

- The channel keeps a long-lived event connection.
- Incoming messages route to the selected Agent/session.
- Task commands create Agent-owned Tasks.
- Delivery returns through the Feishu/Lark bot API.

## Troubleshooting

| Symptom                | Check                                                  |
| ---------------------- | ------------------------------------------------------ |
| Bot receives nothing   | Event subscription, app publish state, bot capability. |
| Send fails             | App secret, app id, permissions, target id.            |
| Group messages ignored | Group policy, mention requirement, chat allowlist.     |
| Lark tenant fails      | `domain: "lark"` and correct developer console.        |

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
