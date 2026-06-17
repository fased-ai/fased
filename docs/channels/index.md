---
summary: "Messaging surfaces Fased can connect to"
read_when:
  - You want to choose a chat channel for Fased
  - You need a quick overview of supported messaging platforms
title: "Chat Channels"
---

# Chat channels

Fased connects to the chat apps you already use through the gateway. Text works
everywhere; media, reactions, threads, voice, and advanced actions depend on
the channel.

For normal browser setup, open **Agents**, select the Agent, then use
**Agent > Channels**. That page owns channel credentials, QR/login flows,
account status, routing to the selected Agent, DM access, allowlists, and
restart-required notices.

```mermaid
flowchart TD
  agent["Select Agent"] --> account["Connect channel account"]
  account --> access["Pair DM / allow groups"]
  access --> route["Route to Agent"]
  route --> test["Send test message"]

  classDef agent fill:#120605,stroke:#ff5a36,color:#ffffff;
  classDef setup fill:#071018,stroke:#12cfff,color:#ffffff;
  classDef ready fill:#20120a,stroke:#ffb020,color:#ffffff;
  class agent agent;
  class account,access,route setup;
  class test ready;
```

The Control UI Channels tab is split into:

- **Accounts**: grouped channel cards and the Connect modal for required fields.
- **Behavior**: reply behavior, reactions, group mention behavior, and TTS.
- **Access**: command and native-tool access for channel users.
- **Sessions**: channel-to-session binding and reset rules.
- **Gateway**: web and gateway settings for channel delivery.

Account cards are grouped as Major, Enterprise, Self-hosted/protocol, and
Optional/plugin so first-run setup stays focused on the common channels.

## Channel map

<CardGroup cols={2}>
  <Card title="Common Setup" icon="message-circle" href="/channels/telegram">
    Start here for WhatsApp, Telegram, Discord, Slack, Signal, or BlueBubbles.
    These are the fastest practical routes to DMs, groups, and team chat.
  </Card>
  <Card title="Team And Enterprise" icon="building-2" href="/channels/googlechat">
    Use Google Chat, Feishu, Microsoft Teams, LINE, Zalo, or Zalo Personal for
    company, regional, or business chat surfaces.
  </Card>
  <Card title="Self-Hosted And Protocol" icon="server" href="/channels/matrix">
    Use IRC, Mattermost, Matrix, Nextcloud Talk, Synology Chat, Nostr, or Tlon
    for self-hosted, protocol-native, or private collaboration routes.
  </Card>
  <Card title="Optional And Legacy" icon="archive" href="/channels/twitch">
    Use Twitch for live chat. Use iMessage only for established `imsg` setups;
    new iMessage-style setups should start with BlueBubbles.
  </Card>
</CardGroup>

Common setup:

- [WhatsApp](/channels/whatsapp)
- [Telegram](/channels/telegram)
- [Discord](/channels/discord)
- [Slack](/channels/slack)
- [Signal](/channels/signal)
- [BlueBubbles](/channels/bluebubbles)

Team and enterprise:

- [Google Chat](/channels/googlechat)
- [Feishu](/channels/feishu)
- [Microsoft Teams](/channels/msteams)
- [LINE](/channels/line)
- [Zalo](/channels/zalo)
- [Zalo Personal](/channels/zalouser)

Self-hosted and protocol:

- [IRC](/channels/irc)
- [Mattermost](/channels/mattermost)
- [Matrix](/channels/matrix)
- [Nextcloud Talk](/channels/nextcloud-talk)
- [Synology Chat](/channels/synology-chat)
- [Nostr](/channels/nostr)
- [Tlon](/channels/tlon)

Optional and legacy:

- [Twitch](/channels/twitch)
- [iMessage](/channels/imessage)

## Runtime status

- **Agent > Channels** shows core channels plus bundled channel extensions from
  the active plugin registry.
- Saving credentials enables that channel for the selected Agent.
- Some bundled channel services need a gateway restart after setup so their
  runtime can register webhooks, sockets, or background monitors.
- External catalog channels install first and expose setup fields after the
  plugin loads.

## Good first choices

- **Telegram** for fastest public bot setup.
- **WhatsApp** for a familiar personal or group assistant.
- **Discord** or **Slack** for team spaces.
- **BlueBubbles** for new iMessage-style setups.
- **Matrix** or **Nextcloud Talk** for self-hosted collaboration.

## Notes

- multiple channels can run at the same time
- channels from the repo are not external downloads; setup starts with their
  credential fields in **Agent > Channels**
- only external catalog channels should use an install/download action
- if a bundled channel shows restart required, restart the gateway before
  testing live messages
- routing is deterministic per peer and per channel; see
  [Channel Routing](/channels/channel-routing)
- group behavior is documented separately in [Groups](/channels/groups)
- DM pairing and allowlists are part of the security model; see
  [Security](/gateway/security) and [Pairing](/channels/pairing)
- fast failure triage starts at
  [Channel Troubleshooting](/channels/troubleshooting)
