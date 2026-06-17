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

**Connected but no DM replies**

First check: `fased pairing list whatsapp`. Fix: approve the sender or change
DM policy.

**Group messages ignored**

First check: `requireMention` and mention patterns. Fix: mention the agent or
relax group policy.

**Relogin loops**

First check: channel probe plus logs. Fix: re-pair and inspect credential
state.

Full page: [WhatsApp](/channels/whatsapp#troubleshooting-quick)

## Telegram

**`/start` works but chat flow does not**

First check: `fased pairing list telegram`. Fix: approve pairing or change DM
policy.

**Bot is online but group stays silent**

First check: privacy mode and mention gating. Fix: disable privacy mode or
mention the bot.

**Send failures or fetch errors**

First check: logs for Telegram API failures. Fix: DNS, IPv6, proxy, or
reachability.

Full page: [Telegram](/channels/telegram#troubleshooting)

## Discord

**Bot is online but guild replies never happen**

First check: `fased channels status --probe`. Fix: verify guild/channel
allowlists and Message Content Intent.

**Group messages ignored**

First check: logs for mention gating. Fix: mention the bot or relax
`requireMention`.

**DMs missing**

First check: `fased pairing list discord`. Fix: approve DM pairing or change
DM policy.

Full page: [Discord](/channels/discord#troubleshooting)

## Slack

**Socket Mode is connected but no replies happen**

First check: `fased channels status --probe`. Fix: verify app token, bot
token, and scopes.

**DMs blocked**

First check: `fased pairing list slack`. Fix: approve pairing or relax DM
policy.

**Channel messages ignored**

First check: `groupPolicy` and allowlists. Fix: allow the channel or open the
policy.

Full page: [Slack](/channels/slack#troubleshooting)

## iMessage and BlueBubbles

**No inbound events**

First check: webhook reachability and server state. Fix: webhook URL or
BlueBubbles server health.

**Can send but cannot receive on macOS**

First check: macOS privacy permissions. Fix: re-grant TCC permissions and
restart.

**DM sender blocked**

First check: `fased pairing list imessage` or
`fased pairing list bluebubbles`. Fix: approve pairing or update allowlist.

Full pages:

- [iMessage](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [BlueBubbles](/channels/bluebubbles#troubleshooting)

## Signal

**Daemon is reachable but bot stays silent**

First check: `fased channels status --probe`. Fix: verify daemon URL, account,
and receive mode.

**DMs blocked**

First check: `fased pairing list signal`. Fix: approve sender or change DM
policy.

**Group replies never trigger**

First check: group allowlist and mention patterns. Fix: add sender/group or
relax gating.

Full page: [Signal](/channels/signal#troubleshooting)

## Matrix

**Logged in but room messages are ignored**

First check: `fased channels status --probe`. Fix: inspect room allowlist and
group policy.

**DMs do not process**

First check: `fased pairing list matrix`. Fix: approve sender or change DM
policy.

**Encrypted rooms fail**

First check: encryption setup. Fix: enable crypto support and rejoin or resync.

Full page: [Matrix](/channels/matrix#troubleshooting)
