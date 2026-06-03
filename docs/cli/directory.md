---
summary: "Look up self, peers, and groups for channels that expose directory data."
read_when:
  - You want to look up contacts/groups/self ids for a channel
  - You are developing a channel directory adapter
title: "directory"
---

# `fased directory`

Use `directory` when you need stable IDs for contacts, groups, or the current account on a channel that exposes directory data.

## Common flags

- `--channel <name>`: channel id/alias (required when multiple channels are configured; auto when only one is configured)
- `--account <id>`: account id (default: channel default)
- `--query <text>`: filter peer/group list results when supported
- `--limit <n>`: cap peer/group list results
- `--json`: output JSON

## Notes

- `directory` is meant to help you find IDs you can paste into other commands (especially `fased message send --target ...`).
- For many channels, results are config-backed (allowlists / configured groups) rather than a live provider directory.
- Default output is a compact table; use `--json` for scripting.
- If a channel adapter does not expose self, peers, groups, or members, the command reports that the directory capability is unsupported for that channel.

## Using results with `message send`

```bash
fased directory peers list --channel slack --query "U0"
fased message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats (by channel)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (group)
- Telegram: `@username` or numeric chat id; groups are numeric ids
- Slack: `user:U…` and `channel:C…`
- Discord: `user:<id>` and `channel:<id>`
- Matrix: `user:@user:server`, `room:!roomId:server`, or `#alias:server`
- Microsoft Teams: `user:<id>` and `conversation:<id>`
- Zalo: user id (Bot API)
- Zalo Personal / `zalouser`: thread id (DM/group) from `zca` (`me`, `friend list`, `group list`)

## Self (“me”)

```bash
fased directory self --channel zalouser
```

## Peers (contacts/users)

```bash
fased directory peers list --channel zalouser
fased directory peers list --channel zalouser --query "name"
fased directory peers list --channel zalouser --limit 50
```

## Groups

```bash
fased directory groups list --channel zalouser
fased directory groups list --channel zalouser --query "work"
fased directory groups members --channel zalouser --group-id <id>
```
