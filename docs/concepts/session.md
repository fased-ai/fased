---
summary: "How Fased groups conversation, task, delivery, and transcript state into sessions."
read_when:
  - Modifying session handling or storage
  - Configuring DM isolation or session cleanup
title: "Session Management"
---

# Session Management

A Session is the context container under an Agent. It owns the conversation
thread, transcript, token counters, task attachments, delivery hints, model
overrides, and reset state for one route of work.

The high-level model is:

```text
Agent -> Session -> Task/Subagent -> Delivery channel
```

Channels deliver messages. They do not own the work. For the product model, see
[Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks).

## Session Keys

Fased stores session rows by `sessionKey`.

Common keys:

| Source             | Shape                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| Main direct chat   | `agent:<agentId>:<mainKey>`                                                        |
| Per-peer DM        | `agent:<agentId>:direct:<peerId>`                                                  |
| Per-channel DM     | `agent:<agentId>:<channel>:direct:<peerId>`                                        |
| Per-account DM     | `agent:<agentId>:<channel>:<accountId>:direct:<peerId>`                            |
| Group/channel chat | `agent:<agentId>:<channel>:group:<id>` or `agent:<agentId>:<channel>:channel:<id>` |
| Thread/topic       | append `:thread:<threadId>` when supported                                         |
| Task run           | `cron:<job.id>` internally                                                         |
| Webhook            | `hook:<uuid>` unless explicitly set                                                |
| Node run           | `node-<nodeId>`                                                                    |

Direct chats default to the main session for continuity. Configure
`session.dmScope` when one Agent can receive private DMs from multiple people.
Older topic-aware channel paths can also contain a `:topic:<threadId>` suffix;
new shared routing uses `:thread:<threadId>`.

## DM Isolation

Use `session.dmScope` to control how direct messages are grouped:

- `main`: all DMs share the Agent main session.
- `per-peer`: isolate by sender id across channels.
- `per-channel-peer`: isolate by channel and sender.
- `per-account-channel-peer`: isolate by account, channel, and sender.

For shared inboxes, prefer `per-channel-peer` or
`per-account-channel-peer`. Use `session.identityLinks` when the same person
should share a canonical session across multiple channels.

```json5
{
  session: {
    dmScope: "per-channel-peer",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
  },
}
```

Run `fased security audit` to review current DM isolation settings.

## Gateway Source Of Truth

The gateway owns session state. UI clients should query gateway APIs instead of
reading local session files.

State lives on the gateway host:

- Store: `~/.fased/agents/<agentId>/sessions/sessions.json`
- Transcript: `~/.fased/agents/<agentId>/sessions/<SessionId>.jsonl`
- Topic transcript: `.../<SessionId>-topic-<threadId>.jsonl`

Session rows can include:

- `sessionId`
- `updatedAt`
- `displayName`, `channel`, `subject`, `room`, `space`
- token counters: `inputTokens`, `outputTokens`, `totalTokens`,
  `contextTokens`
- model/thinking/verbose overrides
- delivery hints and origin metadata

Deleting a single stale session row is allowed; Fased recreates it on the next
matching message.

## Origin Metadata

Session rows record best-effort origin metadata so UIs can explain where a
session came from:

- `label`
- `provider`
- `from` / `to`
- `accountId`
- `threadId`

Connectors should pass inbound labels, sender names, group names, and routing
metadata when they update session state.

## Reset And Lifecycle

Fased reuses a session until a reset rule expires it or the user resets it.

Default behavior:

- daily reset at 4:00 AM local time on the gateway host
- optional idle reset with `session.idleMinutes`
- per-type overrides with `resetByType`
- per-channel overrides with `resetByChannel`
- `/new` and `/reset` create a fresh session id
- isolated task runs use a fresh `sessionId` per run

Example:

```json5
{
  session: {
    reset: { mode: "daily", atHour: 4, idleMinutes: 120 },
    resetByType: {
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
  },
}
```

## Maintenance

Session maintenance keeps session metadata and transcript artifacts bounded.

Defaults:

| Setting                    | Default              |
| -------------------------- | -------------------- |
| `session.maintenance.mode` | `warn`               |
| `pruneAfter`               | `30d`                |
| `maxEntries`               | `500`                |
| `rotateBytes`              | `10mb`               |
| `resetArchiveRetention`    | same as `pruneAfter` |
| `maxDiskBytes`             | disabled             |

Use `mode: "enforce"` to apply cleanup automatically.

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "45d",
      maxEntries: 800,
      rotateBytes: "20mb",
      resetArchiveRetention: "14d",
    },
  },
}
```

Preview or apply cleanup:

```bash
fased sessions cleanup --dry-run
fased sessions cleanup --enforce
```

Large stores should use both time and count limits. If disk usage matters, set
`maxDiskBytes` and `highWaterBytes`.

## Send Policy

Use send policy to block delivery for whole classes of sessions.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Owner commands:

- `/send on`
- `/send off`
- `/send inherit`

Send these as standalone messages.

## Named Channel Sessions

Channel chats can create named child sessions under the current route:

```text
/session new Research
/session list
/session switch Research
/session switch main
```

Normal messages after `/session switch` go to the active named child session.

Tasks created from channel chat or WebChat attach to the active Agent/session.
WebChat exposes this through **Schedule this**.

## Inspecting Sessions

Useful inspection commands:

```bash
fased status
fased sessions --json
fased gateway call sessions.list --params '{}'
```

In chat:

- `/status` checks reachability and current context state.
- `/context list` shows injected context contributors.
- `/compact` summarizes older context.
- `/stop` aborts the active run for that session.

## Related

- [Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks)
- [Session Tools](/concepts/session-tool)
- [Session Pruning](/concepts/session-pruning)
- [Compaction](/concepts/compaction)
- [Memory](/concepts/memory)
