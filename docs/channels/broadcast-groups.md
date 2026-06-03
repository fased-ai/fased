---
summary: "Run multiple agents for the same eligible inbound message"
read_when:
  - Configuring multi-agent replies for a single chat
  - Debugging broadcast behavior in WhatsApp
status: experimental
title: "Broadcast Groups"
---

# Broadcast groups

Broadcast groups let one inbound message trigger multiple agents instead of
exactly one.

Current scope:

- WhatsApp only

Broadcast does not bypass normal policy gates. Pairing, allowlists, group
policy, and mention activation still run first. Broadcast only changes which
agents run once the message is already eligible.

Configure ordinary channel routes in **Agent > Channels** first. Use broadcast
groups only when one eligible inbound message should intentionally run multiple
Agents.

## What it is good for

- specialist agent teams
- quality-review pairs
- logging plus response combinations
- multilingual group replies

## Basic config

Keys are peer ids:

- WhatsApp groups: group JID like `120363403215116621@g.us`
- WhatsApp DMs: E.164 like `+15555550123`

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

Result:

- when that chat would normally receive a reply, all listed agents run

## Strategy

### Parallel

Default and usually preferred:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### Sequential

Runs in listed order:

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

## Example

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## How it works

1. inbound message arrives
2. normal channel gating decides whether the message is eligible
3. if the peer is in `broadcast`, all listed agents run
4. each agent uses its own workspace, session key, and tool policy
5. one agent failure does not block the others

## Isolation model

Each broadcast agent keeps separate:

- session history
- workspace
- tools and policy
- model defaults
- local memory

Shared piece:

- the recent group-context buffer for that peer

That means multiple agents can see the same inbound context without sharing one
conversation state.

## Best practices

- keep each agent narrow in responsibility
- prefer `parallel` unless ordering is important
- keep the group small; 5 to 10 agents is already a lot
- give each agent only the tools it actually needs
- use lighter models for narrow helpers when possible

## Compatibility

Implemented:

- WhatsApp

Planned or future candidates:

- Telegram
- Discord
- Slack

## Routing precedence

`broadcast` takes priority over normal `bindings` for the matching peer.

Example:

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`
  - normal single-agent routing
- `GROUP_B`
  - broadcast routing

## Troubleshooting

### Agents do not respond

Check:

- the peer id is correct
- the agent ids exist in `agents.list`
- the message was actually eligible after group gating

### Only one agent responds

Likely causes:

- the peer is not actually in `broadcast`
- the message was handled by normal routing
- one or more broadcast agents errored

### Performance is poor

Reduce:

- number of agents
- model weight
- sandbox startup cost

Watch logs:

```bash
fased logs --follow
```

## Limits

- no hard coded agent limit, but large groups get slow
- agents do not see each other's replies
- parallel replies can arrive in any order
- all outbound replies still count toward channel rate limits

## Related

- [Channel Routing](/channels/channel-routing)
- [Groups](/channels/groups)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
