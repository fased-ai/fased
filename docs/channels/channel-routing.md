---
summary: "Deterministic routing, session keys, and agent selection per channel"
read_when:
  - Changing channel routing or inbox behavior
  - Wiring multi-agent bindings
title: "Channel Routing"
---

# Channels and routing

Fased routes replies back to the surface that produced the inbound message. The
model does not choose a channel. Routing is deterministic and comes from host
configuration, peer bindings, and session-key rules.

For normal setup, open **Agents**, select the Agent, then use **Agent >
Channels**. That page writes the common channel account and route settings for
the selected Agent. Advanced `bindings` remain available for multi-Agent or
role/peer-specific routing.

## Key terms

- **channel**
  - `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`,
    `webchat`, and plugin channels
- **accountId**
  - a channel-specific account instance when the provider supports it
- **agentId**
  - the selected agent workspace and session store
- **sessionKey**
  - the concurrency and context bucket for the conversation

## Session-key shapes

Direct messages usually collapse into the agent's main session:

- `agent:<agentId>:<mainKey>`
- default example: `agent:main:main`

Groups, rooms, and channels stay isolated:

- groups: `agent:<agentId>:<channel>:group:<id>`
- channels or rooms: `agent:<agentId>:<channel>:channel:<id>`

Threads extend the base key:

- Slack and Discord: `:thread:<threadId>`
- Telegram forum topics: `:topic:<topicId>`

Examples:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## How agent selection works

Routing chooses one agent for each inbound message.

Matching order:

1. exact peer match from `bindings`
2. parent peer match for thread inheritance
3. Discord guild + roles match
4. Discord guild match
5. Slack team match
6. account match
7. channel match
8. default agent

If a binding includes multiple selectors, all provided fields must match.

The chosen agent controls:

- workspace
- session store
- tools and policy
- model defaults

Channels do not own model choice, memory, sessions, or tasks. They only
provide transport and delivery. The durable work model is:

```text
Agent -> Session -> Task/Subagent -> Delivery channel
```

So a Telegram DM can deliver a task result, but the task is owned by the routed
Agent and active Session. See [Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks).

## Broadcast groups

Broadcast groups are the exception to the one-agent rule. They let multiple
agents run for the same eligible inbound message.

Example:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Broadcasts do not bypass pairing, allowlists, or mention gating. They only
change which agents run after the message is already eligible.

See [Broadcast Groups](/channels/broadcast-groups).

## Config overview

Main pieces:

- `agents.list`
- `bindings`
- `broadcast`

Use **Agent > Channels** for ordinary one-channel-to-one-Agent routes. Use raw
`bindings` only when you need matching by peer, account, team, guild, role, or
thread inheritance.

Example:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.fased/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    {
      match: { channel: "telegram", peer: { kind: "group", id: "-100123" } },
      agentId: "support",
    },
  ],
}
```

## Session storage

By default, session state lives under:

- `~/.fased/agents/<agentId>/sessions/sessions.json`

JSONL transcripts live alongside the session store.

You can override this with `session.store` and `{agentId}` templating.

## WebChat behavior

WebChat attaches to a selected agent and usually uses that agent's main
session. That makes it useful as a unified operator view into an agent that may
also be talking on other channels.

WebChat can also create named local sessions and schedule tasks with
**Schedule this**. Those tasks use the same scheduler-backed records as `/task new`
from Telegram/Discord/etc.

## Channel command controls

Channel chats can switch Agents, create named sessions, and create/cancel tasks
without giving the Channel ownership over those objects:

```text
/agent list
/agent switch Research
/session new Market watch
/session list
/session switch Market watch
/task new every 1h Market watch: Monitor market risk with a cheap check first and escalate if deeper analysis is needed.
/task list
/task show <id>
/task run <id>
/task pause <id>
/task resume <id>
/task cancel <id>
```

Route assignment decides which Agent receives the next inbound message. Session
selection decides which conversation/task context receives it. Task commands
write scheduled work tied to that Agent/session.

`/task list` is a compact operational view: plan, delivery target, next run,
and last result. `/task show <id>` expands the task policy, budget, delivery,
run counters, and evaluator state. `/task run <id>` now returns the immediate
run outcome and points to `/task show` for details. `/task resume <id>` re-runs
preflight; if a required API key, provider, channel, wallet policy, or skill
setup is still missing, the task stays blocked and the reply shows the setup
target.

For cheap-first task wording, Fased stores a planner/evaluator policy and
injects the human-readable escalation cue itself. Users should describe the
desired behavior in normal language; raw model, memory, skill, budget, and stop
flags remain available for advanced control.

## Reply context

When the provider supports it, inbound messages can include:

- `ReplyToId`
- `ReplyToBody`
- `ReplyToSender`

Quoted context is appended into the normalized message body so the agent sees
what the sender was replying to, even across different channel transports.
