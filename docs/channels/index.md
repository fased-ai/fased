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
account status, routing to the selected Agent, DM policy, allowlists, and
restart-required notices.

```mermaid
flowchart LR
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
- **Runtime**: web/runtime settings for channel delivery.

Account cards are grouped as Major, Enterprise, Self-hosted/protocol, and
Optional/plugin so first-run setup stays focused on the common channels.

## Channel map

| Group                    | Channels                                                                                                                                                                                                                     | Use when                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Common setup             | [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Slack](/channels/slack), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles)                                     | You want the fastest practical route to DMs, groups, or team chat.                                                           |
| Team and enterprise      | [Google Chat](/channels/googlechat), [Feishu](/channels/feishu), [Microsoft Teams](/channels/msteams), [LINE](/channels/line), [Zalo](/channels/zalo), [Zalo Personal](/channels/zalouser)                                   | You are connecting a company, regional app, or business chat surface.                                                        |
| Self-hosted and protocol | [IRC](/channels/irc), [Mattermost](/channels/mattermost), [Matrix](/channels/matrix), [Nextcloud Talk](/channels/nextcloud-talk), [Synology Chat](/channels/synology-chat), [Nostr](/channels/nostr), [Tlon](/channels/tlon) | You want self-hosted, protocol-native, or private collaboration routes.                                                      |
| Optional and legacy      | [Twitch](/channels/twitch), [iMessage](/channels/imessage)                                                                                                                                                                   | You need a live-stream chat bridge or an established legacy `imsg` setup. New iMessage setups should start with BlueBubbles. |

## Runtime status

- Fresh gateway runtime loads Telegram and Discord by default.
- Bundled/local channel rows appear in **Agent > Channels** with setup fields.
- Saving credentials enables that channel for the selected Agent.
- Some local channel runtimes need a gateway restart after setup.
- External catalog channels install first and expose setup fields after the plugin loads.

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
- if a local bundled channel is configured while its plugin is not loaded,
  restart the gateway to load that channel runtime
- routing is deterministic per peer and per channel; see
  [Channel Routing](/channels/channel-routing)
- group behavior is documented separately in [Groups](/channels/groups)
- DM pairing and allowlists are part of the security model; see
  [Security](/gateway/security) and [Pairing](/channels/pairing)
- fast failure triage starts at
  [Channel Troubleshooting](/channels/troubleshooting)
