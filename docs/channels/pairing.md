---
summary: "Approve DM senders and device/node joins"
read_when:
  - Setting up DM access control
  - Pairing a new iOS or Android node
  - Reviewing channel access security
title: "Pairing"
---

# Pairing

Pairing is Fased's explicit approval step. It is used in two different places:

1. **DM pairing**
   - who is allowed to talk to the gateway through a channel
2. **device or node pairing**
   - which devices are allowed to join the gateway

Security context: [Security](/gateway/security)

## DM pairing

When a channel DM policy is set to `pairing`, unknown senders do not get full
message processing immediately. They receive a short code and stay pending until
you approve them.

Properties:

- 8 characters
- uppercase
- avoids ambiguous characters like `0`, `O`, `1`, and `I`
- expires after 1 hour
- pending requests are capped per channel

### Approve a sender

In the browser UI, open **Agents**, select the Agent, then use **Agent > Channels**
to review pending DM pairing requests for that channel. CLI approval is also
available:

```bash
fased pairing list telegram
fased pairing approve telegram <CODE>
```

Supported channels include:

- `telegram`
- `whatsapp`
- `signal`
- `imessage`
- `discord`
- `slack`
- `feishu`

### Where DM pairing state lives

Under `~/.fased/credentials/`:

- pending requests: `<channel>-pairing.json`
- approved allowlist store:
  - default account: `<channel>-allowFrom.json`
  - non-default account: `<channel>-<accountId>-allowFrom.json`

Treat these files as sensitive. They decide who can reach your agent.

## Device and node pairing

Gateway-connected devices use `role: node`. They create pairing requests that
must be approved before they become trusted participants.

### Telegram-assisted device pairing

If you use the device-pair path:

1. message your Telegram bot with `/pair`
2. Fased returns an instruction message plus a setup code
3. open the mobile app and paste the setup code into Gateway settings
4. approve the request

The setup code contains:

- `url`
  - gateway websocket URL
- `token`
  - short-lived pairing token

Treat the setup code like a password until it expires.

### Approve or reject a device

```bash
fased devices list
fased devices approve <requestId>
fased devices reject <requestId>
```

### Where device pairing state lives

Under `~/.fased/devices/`:

- `pending.json`
- `paired.json`

Pending requests expire automatically. Paired devices and their tokens are kept
in the paired store.

## Notes

- the legacy `node.pair.*` path is separate from the current device-pair flow
- websocket nodes still need explicit approval
- channel DM pairing and device pairing solve different problems; do not treat
  them as interchangeable

## Related

- [Security](/gateway/security)
- [Updating](/install/updating)
- [Telegram](/channels/telegram)
- [WhatsApp](/channels/whatsapp)
- [Signal](/channels/signal)
- [BlueBubbles](/channels/bluebubbles)
- [iMessage](/channels/imessage)
- [Discord](/channels/discord)
- [Slack](/channels/slack)
