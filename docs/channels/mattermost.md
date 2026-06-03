---
summary: "Mattermost bot token setup, WebSocket routing, and channel policy in Fased."
read_when:
  - Setting up Mattermost
  - Debugging Mattermost routing
title: "Mattermost"
---

# Mattermost

Mattermost is the self-hosted Slack-like option when you want familiar team chat but keep the server in your own environment. Fased connects with a bot token, listens over Mattermost’s event stream, and applies the standard DM, channel, and mention controls from the gateway.

Status: bundled channel extension for DMs, channels, and groups over bot-token auth plus live events.

## Setup from Agent > Channels

Mattermost ships with Fased as a local bundled channel extension. You do not
need to download an npm package in a normal install.

Open **Agents**, select the Agent, then use **Agent > Channels > Mattermost**.
Enter the base URL and bot token, save the channel, then restart the gateway if
the UI reports that the runtime still needs to load.

## Quick setup

The minimal path is one Mattermost bot user, one base URL, and one bot token. Start there before adding multi-account or per-channel policies.

1. Create a Mattermost bot account and copy the **bot token**.
2. Copy the Mattermost **base URL** (e.g., `https://chat.example.com`).
3. Open **Agent > Channels > Mattermost**, enter the credentials, and save.
4. Restart the gateway if the UI asks for it.

Minimal config:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Environment variables (default account)

Set these on the gateway host if you prefer env vars:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env vars apply only to the **default** account (`default`). Other accounts must use config values.

## Chat modes

Mattermost responds to DMs automatically. Channel behavior is controlled by `chatmode`:

- `oncall` (default): respond only when @mentioned in channels.
- `onmessage`: respond to every channel message.
- `onchar`: respond when a message starts with a trigger prefix.

Config example:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Notes:

- `onchar` still responds to explicit @mentions.
- `channels.mattermost.requireMention` is honored for legacy configs but `chatmode` is preferred.

## Access control (DMs)

- Default: `channels.mattermost.dmPolicy = "pairing"` (unknown senders get a pairing code).
- Approve via:
  - `fased pairing list mattermost`
  - `fased pairing approve mattermost <CODE>`
- Public DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Channels (groups)

- Default: `channels.mattermost.groupPolicy = "allowlist"` (mention-gated).
- Allowlist senders with `channels.mattermost.groupAllowFrom` (user IDs recommended).
- `@username` matching is mutable and only enabled when `channels.mattermost.dangerouslyAllowNameMatching: true`.
- Open channels: `channels.mattermost.groupPolicy="open"` (mention-gated).
- Runtime note: if `channels.mattermost` is completely missing, runtime falls back to `groupPolicy="allowlist"` for group checks (even if `channels.defaults.groupPolicy` is set).

## Targets for outbound delivery

Use these target formats with `fased message send` or cron/webhooks:

- `channel:<id>` for a channel
- `user:<id>` for a DM
- `@username` for a DM (resolved via the Mattermost API)

Bare IDs are treated as channels.

## Reactions (message tool)

- Use `message action=react` with `channel=mattermost`.
- `messageId` is the Mattermost post id.
- `emoji` accepts names like `thumbsup` or `:+1:` (colons are optional).
- Set `remove=true` (boolean) to remove a reaction.
- Reaction add/remove events are forwarded as system events to the routed agent session.

Examples:

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

Config:

- `channels.mattermost.actions.reactions`: enable/disable reaction actions (default true).
- Per-account override: `channels.mattermost.accounts.<id>.actions.reactions`.

## Multi-account

Mattermost supports multiple accounts under `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Troubleshooting

- No replies in channels: ensure the bot is in the channel and mention it (oncall), use a trigger prefix (onchar), or set `chatmode: "onmessage"`.
- Auth errors: check the bot token, base URL, and whether the account is enabled.
- Multi-account issues: env vars only apply to the `default` account.
