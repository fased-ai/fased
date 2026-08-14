---
summary: "WhatsApp Web setup, DM and group policy, and operational guidance for Fased."
read_when:
  - Setting up WhatsApp
  - Debugging WhatsApp Web login, DMs, groups, or delivery
title: "WhatsApp"
---

# WhatsApp

**Delivery:** Bundled.

WhatsApp in Fased uses linked WhatsApp Web sessions. The gateway owns the socket
state, routes DMs and groups separately, and lets you choose a personal-number
or dedicated-number operating model.

Status: supported through WhatsApp Web using Baileys.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Unknown DMs can require approval.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Group allowlists and mention behavior.
  </Card>
  <Card title="Troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Shared channel repair steps.
  </Card>
</CardGroup>

## Quick setup

1. Open **Agents > selected Agent > Channels > WhatsApp** and enable it. The
   signed Fased generation already contains the integration.
2. Return to **Agent > Channels > WhatsApp**.
3. Choose personal-number or dedicated-number setup.
4. Keep DM policy on `pairing` or `allowlist` to start.
5. Scan the QR code from WhatsApp.
6. Approve the first pairing request if using pairing mode.

CLI login:

```bash
fased channels login --channel whatsapp
fased pairing list whatsapp
fased pairing approve whatsapp <CODE>
```

Config shape:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

## Operating model

| Mode             | Use when                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Dedicated number | You want a clear bot identity and cleaner allowlists.                                     |
| Personal number  | You need to use an existing WhatsApp account and accept tighter self-chat/allowlist care. |

When possible, use a dedicated number for Fased.

## Runtime behavior

- Linked session state is stored locally by the gateway.
- DMs and groups route separately.
- Group replies should start mention-gated or allowlisted.
- Task commands create Agent-owned Tasks; WhatsApp is the transport.
- Media and long output are subject to channel limits and chunking behavior.

## Access model

| Area                 | Recommended start                         |
| -------------------- | ----------------------------------------- |
| DMs                  | pairing or allowlist                      |
| Groups               | allowlist plus mention gating             |
| Personal-number mode | explicit self-chat and sender policy      |
| Multi-account        | named account per linked WhatsApp session |

## Troubleshooting

| Symptom               | Check                                                        |
| --------------------- | ------------------------------------------------------------ |
| QR login fails        | Existing session state, phone connectivity, gateway logs.    |
| Bot ignores DMs       | Pairing state, allowlist, phone number format.               |
| Group replies missing | Group policy, mention requirement, group sender allowlist.   |
| Session disconnects   | Re-link QR and check host sleep/network state.               |
| Messages duplicate    | Personal-number self-chat policy and route/session settings. |

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Troubleshooting](/channels/troubleshooting)
