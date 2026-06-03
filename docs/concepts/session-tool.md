---
summary: "Agent session tools for listing sessions, fetching history, sending between sessions, and spawning sub-agents."
read_when:
  - Adding or modifying session tools
title: "Session Tools"
---

# Session Tools

Session tools let an Agent inspect session state, fetch transcript snippets,
send messages into another session, or spawn a bounded sub-agent run.

For the product ownership model, read
[Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks).

## Tool Names

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Key Model

Common session keys:

| Source           | Shape                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| Main direct chat | `main` resolves to the current Agent main key                         |
| Direct chat      | `agent:<agentId>:direct:<peerId>` or channel/account-scoped variants  |
| Group/channel    | full `agent:<agentId>:<channel>:group:<id>` or `...:channel:<id>` key |
| Scheduled task   | `cron:<job.id>` internally                                            |
| Webhook          | `hook:<uuid>` unless explicitly set                                   |
| Node run         | `node-<nodeId>` unless explicitly set                                 |

`global` and `unknown` are reserved and are not listed. If legacy config uses
`session.scope = "global"`, tools expose it as `main`.

## `sessions_list`

Lists session rows.

Parameters:

- `kinds?: string[]`
- `limit?: number`
- `activeMinutes?: number`
- `messageLimit?: number`

Rows can include the key, kind, channel, display name, timestamps, session id,
model/context counters, send policy, delivery context, transcript path, and
optional recent messages.

When running in a sandboxed session, visibility is clamped by the sandbox policy
described below.

## `sessions_history`

Fetches transcript messages for one session.

Parameters:

- `sessionKey`
- `limit?: number`
- `includeTools?: boolean`

`sessionKey` accepts `main`, a full session key, or a session id string that can
be resolved by the gateway. By default, tool-result messages are filtered out.

## `sessions_send`

Sends a message into another session.

Parameters:

- `sessionKey?`
- `label?`
- `agentId?`
- `message`
- `timeoutSeconds?: number`

Use either `sessionKey` or `label`, not both. When `label` is used, `agentId`
can disambiguate same-name sessions if cross-agent policy allows it.

Behavior:

- `timeoutSeconds = 0`: enqueue and return immediately.
- `timeoutSeconds > 0`: wait for completion or timeout through gateway
  `agent.wait`.
- inter-session messages are stored with
  `message.provenance.kind = "inter_session"`.
- reply-back loops are bounded by `session.agentToAgent.maxPingPongTurns`.
- announce steps can reply `ANNOUNCE_SKIP` to stay silent.

## `sessions_spawn`

Spawns a sub-agent run in an isolated session and announces the result back to
the requester channel when delivery is available.

Parameters:

- `task`
- `label?`
- `agentId?`
- `model?`
- `thinking?`
- `runTimeoutSeconds?`
- `timeoutSeconds?` (back-compat alias for `runTimeoutSeconds`)
- `thread?`
- `runtime?`
- `mode?`
- `cleanup?`

Rules:

- `runtime` is `subagent` by default; `acp` targets an ACP harness runtime
- allowed target Agents come from `agents.defaults.subagents.allowAgents` or
  `agents.list[].subagents.allowAgents`
- sub-agent sessions use `agent:<agentId>:subagent:<uuid>`
- sub-agents do not receive session tools by default
- nested spawns are blocked unless the sub-agent depth policy explicitly allows
  them
- the tool returns `{ status: "accepted", runId, childSessionKey }`
- channel plugins may bind `thread=true` spawns to thread routing when
  supported

## Visibility

Session tools can be scoped:

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      visibility: "tree",
    },
  },
  agents: {
    defaults: {
      sandbox: {
        sessionToolsVisibility: "spawned",
      },
    },
  },
}
```

Meanings:

- `self`: current session only.
- `tree`: current session plus sessions spawned by it.
- `agent`: any session for the current Agent.
- `all`: any session, subject to cross-agent policy.
- sandboxed sessions clamp to the configured sandbox visibility.

## Channel Session Commands

External channel chats expose a small command layer for the same model:

```text
/agent list
/agent switch <agent>
/session new <name>
/session list
/session switch <name|main>
/task new every <duration> [<name>:] <prompt>
/task list
/task show <id>
/task run <id>
/task runs <id>
/task last <id>
/task approve <id>
/task pause <id>
/task resume <id>
/task cancel <id>
```

These commands mutate route, session, or task state. The session tools above are
Agent tool APIs used from inside a run.

## Send Policy

Delivery can be blocked by channel/chat type:

```json5
{
  session: {
    sendPolicy: {
      rules: [{ match: { channel: "discord", chatType: "group" }, action: "deny" }],
      default: "allow",
    },
  },
}
```

Runtime overrides can be set with owner-only `/send on`, `/send off`, and
`/send inherit` commands.

## Related

- [Session Management](/concepts/session)
- [Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks)
- [Task Operating Layer](/concepts/task-operating-layer)
