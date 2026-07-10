---
summary: "Matrix account setup, room policy, encryption support, and Fased gateway wiring."
read_when:
  - Working on Matrix channel features
title: "Matrix"
---

# Matrix

Matrix is the right channel when you want federated messaging, self-hosted
homeservers, and optional end-to-end encryption. The gateway logs in as a
Matrix user, handles DMs and rooms, and keeps per-room policy separate from DM
access.

Status: source extension. DMs, rooms, threads, media, reactions, location,
polls-as-text, and Matrix E2EE are available when its Matrix runtime
dependencies are installed.

## Setup from Agent > Channels

Matrix is available from a source install. The lightweight hosted runtime does
not currently include the Matrix SDK dependencies, and Matrix does not yet have
an official Fased add-on package. Use a maintained source install for this
channel.

Open **Agents**, select the Agent, then use **Agent > Channels > Matrix**. Enter
the homeserver and either an access token or username/password. Save the
channel, then restart the gateway if the UI reports that the runtime still
needs to load.

## Setup

You need a Matrix user for the bot plus either an access token or a
username/password flow the gateway can exchange for a token.

1. Create a Matrix account on a homeserver:
   - Browse hosting options at [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Or host it yourself.
2. Get an access token for the bot account:
   - Use the Matrix login API with `curl` at your home server:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Replace `matrix.example.org` with your homeserver URL.
   - Or set `channels.matrix.userId` + `channels.matrix.password`: Fased calls
     the same login endpoint, stores the access token in
     `~/.fased/credentials/matrix/credentials.json`, and reuses it on next
     start.

3. Configure credentials in **Agent > Channels > Matrix**:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, or
     `MATRIX_USER_ID` + `MATRIX_PASSWORD`
   - Or config: `channels.matrix.*`
   - If both are set, config takes precedence.
   - With access token: user ID is fetched automatically via `/whoami`.
   - When set, `channels.matrix.userId` should be the full Matrix ID, such as
     `@bot:example.org`.
4. Restart the gateway if the UI asks for it.
5. Start a DM with the bot or invite it to a room from any Matrix client.
   Beeper requires E2EE, so set `channels.matrix.encryption: true` and verify
   the device.

Minimal config (access token, user ID auto-fetched):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE config (end to end encryption enabled):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Encryption (E2EE)

End-to-end encryption is **supported** via the Rust crypto SDK.

Enable with `channels.matrix.encryption: true`:

- If the crypto module loads, encrypted rooms are decrypted automatically.
- Outbound media is encrypted when sending to encrypted rooms.
- On first connection, Fased requests device verification from your other sessions.
- Verify the device in another Matrix client (Element, etc.) to enable key sharing.
- If the crypto module cannot be loaded, E2EE is disabled and encrypted rooms
  will not decrypt; Fased logs a warning.
- If you see missing crypto module errors, such as
  `@matrix-org/matrix-sdk-crypto-nodejs-*`,
  allow build scripts for `@matrix-org/matrix-sdk-crypto-nodejs` and run
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` or fetch the binary with
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

Crypto state is stored per account + access token in
`~/.fased/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite database). Sync state lives alongside it in `bot-storage.json`.
If the access token (device) changes, a new store is created and the bot must be
re-verified for encrypted rooms.

**Device verification:** when E2EE is enabled, the bot requests verification
from your other sessions on startup. Open Element or another Matrix client and
approve the request. Once verified, the bot can decrypt messages in encrypted
rooms.

## Multi-account

Multi-account support uses `channels.matrix.accounts` with per-account
credentials and optional `name`. See
[gateway configuration](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)
for the shared pattern.

Each account runs as a separate Matrix user on any homeserver. Per-account config
inherits from the top-level `channels.matrix` settings and can override any option
(DM policy, groups, encryption, etc.).

```json5
{
  channels: {
    matrix: {
      enabled: true,
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          name: "Main assistant",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_***",
          encryption: true,
        },
        alerts: {
          name: "Alerts bot",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_***",
          dm: { policy: "allowlist", allowFrom: ["@admin:example.org"] },
        },
      },
    },
  },
}
```

Notes:

- Account startup is serialized to avoid race conditions with concurrent module imports.
- Env variables such as `MATRIX_HOMESERVER` and `MATRIX_ACCESS_TOKEN` apply
  only to the **default** account.
- Base channel settings apply to all accounts unless overridden per account.
- Use `bindings[].match.accountId` to route each account to a different agent.
- Crypto state is stored per account + access token (separate key stores per account).

## Routing model

- Replies always go back to Matrix.
- DMs share the agent's main session; rooms map to group sessions.

## Access control (DMs)

- Default: `channels.matrix.dm.policy = "pairing"`. Unknown senders get a
  pairing code.
- Approve via:
  - `fased pairing list matrix`
  - `fased pairing approve matrix <CODE>`
- Public DMs: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` accepts full Matrix user IDs, such as
  `@user:server`. The wizard resolves display names to user IDs when directory
  search finds a single exact match.
- Use full `@user:server` IDs for allowlists. Display names and bare localparts
  such as `"Alice"` or `"alice"` are ambiguous.

## Rooms (groups)

- Default: `channels.matrix.groupPolicy = "allowlist"` with mention gating.
  Use `channels.defaults.groupPolicy` to override the default when unset.
- Runtime note: if `channels.matrix` is completely missing, runtime falls back
  to `groupPolicy="allowlist"` for room checks.
- Allowlist rooms with `channels.matrix.groups`. Use room IDs or aliases; names
  resolve to IDs only on an exact, unique match.

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` enables auto-reply in that room.
- `groups."*"` can set defaults for mention gating across rooms.
- `groupAllowFrom` restricts which senders can trigger the bot in rooms. Use
  full Matrix user IDs.
- Per-room `users` allowlists can further restrict senders inside a specific
  room. Use full Matrix user IDs.
- Agent > Channels and CLI setup can prompt for room allowlists (room IDs,
  aliases, or names) and resolve names only on an exact, unique match.
- On startup, Fased resolves room/user names in allowlists to IDs and logs the
  mapping. Unresolved entries are ignored for allowlist matching.
- Invites are auto-joined by default; control with `channels.matrix.autoJoin` and `channels.matrix.autoJoinAllowlist`.
- To allow **no rooms**, set `channels.matrix.groupPolicy: "disabled"` (or keep an empty allowlist).
- Legacy key: `channels.matrix.rooms` (same shape as `groups`).

## Threads

- Reply threading is supported.
- `channels.matrix.threadReplies` controls whether replies stay in threads:
  - `off`, `inbound` (default), `always`
- `channels.matrix.replyToMode` controls reply-to metadata when not replying in a thread:
  - `off` (default), `first`, `all`

## Capabilities

**Direct messages, rooms, threads, media, reactions, location, and native commands**

Supported.

**E2EE**

Supported when the crypto module is available.

**Polls**

Send is supported. Inbound poll starts are converted to text; responses and
ends are ignored.

## Troubleshooting

Run this ladder first:

```bash
fased status
fased gateway status
fased logs --follow
fased doctor
fased channels status --probe
```

Then confirm DM pairing state if needed:

```bash
fased pairing list matrix
```

Common failures:

- Logged in but room messages ignored: room blocked by `groupPolicy` or room allowlist.
- DMs ignored: sender pending approval when `channels.matrix.dm.policy="pairing"`.
- Encrypted rooms fail: crypto support or encryption settings mismatch.

For triage flow: [/channels/troubleshooting](/channels/troubleshooting).

## Configuration reference (Matrix)

Full configuration: [Configuration](/gateway/configuration)

Provider options:

- `channels.matrix.enabled`: enable/disable channel startup.
- `channels.matrix.homeserver`: homeserver URL.
- `channels.matrix.userId`: Matrix user ID (optional with access token).
- `channels.matrix.accessToken`: access token.
- `channels.matrix.password`: password for login (token stored).
- `channels.matrix.deviceName`: device display name.
- `channels.matrix.encryption`: enable E2EE (default: false).
- `channels.matrix.initialSyncLimit`: initial sync limit.
- `channels.matrix.threadReplies`: `off | inbound | always` (default: inbound).
- `channels.matrix.textChunkLimit`: outbound text chunk size (chars).
- `channels.matrix.chunkMode`: `length` or `newline`; `newline` splits on
  blank lines before length chunking.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled`
  (default: pairing).
- `channels.matrix.dm.allowFrom`: DM allowlist with full Matrix user IDs.
  `open` requires `"*"`.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (default: allowlist).
- `channels.matrix.groupAllowFrom`: allowlisted senders for group messages (full Matrix user IDs).
- `channels.matrix.allowlistOnly`: force allowlist rules for DMs + rooms.
- `channels.matrix.groups`: group allowlist + per-room settings map.
- `channels.matrix.rooms`: legacy group allowlist/config.
- `channels.matrix.replyToMode`: reply-to mode for threads/tags.
- `channels.matrix.mediaMaxMb`: inbound/outbound media cap (MB).
- `channels.matrix.autoJoin`: invite handling (`always | allowlist | off`,
  default: always).
- `channels.matrix.autoJoinAllowlist`: allowed room IDs/aliases for auto-join.
- `channels.matrix.accounts`: multi-account configuration keyed by account ID.
  Each account inherits top-level settings.
- `channels.matrix.actions`: per-action tool gating (reactions/messages/pins/memberInfo/channelInfo).
