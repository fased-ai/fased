---
summary: "Fast per-channel failure signatures and first checks"
read_when:
  - A channel says connected but replies fail
  - You need a fast per-channel triage path
title: "Channel Troubleshooting"
---

# Channel troubleshooting

Use this page when a channel looks configured but the live behavior is wrong.

Start in **Agents > selected Agent > Channels**. Confirm the account is
configured, the route points to the expected Agent, DM/group policy is what you
intended, and any restart-required notice has been handled. Then use the CLI
checks below when you need runtime details.

## Command ladder

Run these first:

```bash
fased status
fased gateway status
fased logs --follow
fased doctor
fased channels status --probe
```

Healthy baseline:

- runtime is running
- gateway RPC probe is healthy
- the channel probe reports ready or connected

## WhatsApp

| Symptom                     | First check                                   | Fix                                     |
| --------------------------- | --------------------------------------------- | --------------------------------------- |
| connected but no DM replies | `fased pairing list whatsapp`                 | approve sender or change DM policy      |
| group messages ignored      | inspect `requireMention` and mention patterns | mention the agent or relax group policy |
| relogin loops               | channel probe plus logs                       | re-pair and inspect credential state    |

Full page: [WhatsApp](/channels/whatsapp#troubleshooting-quick)

## Telegram

| Symptom                               | First check                            | Fix                                     |
| ------------------------------------- | -------------------------------------- | --------------------------------------- |
| `/start` works but chat flow does not | `fased pairing list telegram`          | approve pairing or change DM policy     |
| bot is online but group stays silent  | check privacy mode and mention gating  | disable privacy mode or mention the bot |
| send failures or fetch errors         | inspect logs for Telegram API failures | fix DNS, IPv6, proxy, or reachability   |

Full page: [Telegram](/channels/telegram#troubleshooting)

## Discord

| Symptom                                      | First check                     | Fix                                                          |
| -------------------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| bot is online but guild replies never happen | `fased channels status --probe` | verify guild or channel allowlist and message-content intent |
| group messages ignored                       | inspect logs for mention gating | mention the bot or relax `requireMention`                    |
| DMs missing                                  | `fased pairing list discord`    | approve DM pairing or change DM policy                       |

Full page: [Discord](/channels/discord#troubleshooting)

## Slack

| Symptom                                        | First check                          | Fix                                     |
| ---------------------------------------------- | ------------------------------------ | --------------------------------------- |
| Socket Mode is connected but no replies happen | `fased channels status --probe`      | verify app token, bot token, and scopes |
| DMs blocked                                    | `fased pairing list slack`           | approve pairing or relax DM policy      |
| channel messages ignored                       | inspect `groupPolicy` and allowlists | allow the channel or open the policy    |

Full page: [Slack](/channels/slack#troubleshooting)

## iMessage and BlueBubbles

| Symptom                              | First check                                        | Fix                                          |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------- |
| no inbound events                    | verify webhook reachability and server state       | fix webhook URL or BlueBubbles server health |
| can send but cannot receive on macOS | inspect macOS privacy permissions                  | re-grant TCC permissions and restart         |
| DM sender blocked                    | `fased pairing list imessage` or `... bluebubbles` | approve pairing or update allowlist          |

Full pages:

- [iMessage](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [BlueBubbles](/channels/bluebubbles#troubleshooting)

## Signal

| Symptom                                  | First check                                  | Fix                                          |
| ---------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| daemon is reachable but bot stays silent | `fased channels status --probe`              | verify daemon URL, account, and receive mode |
| DMs blocked                              | `fased pairing list signal`                  | approve sender or change DM policy           |
| group replies never trigger              | inspect group allowlist and mention patterns | add sender or group, or relax gating         |

Full page: [Signal](/channels/signal#troubleshooting)

## Matrix

| Symptom                                 | First check                     | Fix                                        |
| --------------------------------------- | ------------------------------- | ------------------------------------------ |
| logged in but room messages are ignored | `fased channels status --probe` | inspect room allowlist and group policy    |
| DMs do not process                      | `fased pairing list matrix`     | approve sender or change DM policy         |
| encrypted rooms fail                    | inspect encryption setup        | enable crypto support and rejoin or resync |

Full page: [Matrix](/channels/matrix#troubleshooting)
