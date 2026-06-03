---
summary: "How inbound messages turn into replies in Fased, including sessions, queueing, and reasoning visibility."
read_when:
  - Explaining how inbound messages become replies
  - Clarifying sessions, queueing modes, or streaming behavior
  - Documenting reasoning visibility and usage implications
title: "Messages"
---

# Messages

This page ties together how Fased handles inbound messages, sessions, queueing,
streaming, and reasoning visibility.

## Message flow (high level)

```mermaid
flowchart LR
  Inbound[Inbound message] --> Routing[Routing and bindings]
  Routing --> Session[Session key]
  Session --> Queue[Queue or active run]
  Queue --> Run[Agent run]
  Run --> Reply[Outbound reply]

  classDef primary fill:#120605,stroke:#ff5a36,color:#fff
  classDef support fill:#071018,stroke:#12cfff,color:#fff
  class Inbound,Run,Reply primary
  class Routing,Session,Queue support
```

Key knobs live in configuration:

- `messages.*` for prefixes, queueing, and group behavior.
- `agents.defaults.*` for block streaming and chunking defaults.
- Channel overrides (`channels.whatsapp.*`, `channels.telegram.*`, etc.) for caps and streaming toggles.

See [Configuration](/gateway/configuration) for full schema.

## Inbound dedupe

Channels can redeliver the same message after reconnects. Fased keeps a
short-lived cache keyed by channel/account/peer/session/message id so duplicate
deliveries do not trigger another agent run.

## Inbound debouncing

Rapid consecutive messages from the **same sender** can be batched into a single
agent turn via `messages.inbound`. Debouncing is scoped per channel + conversation
and uses the most recent message for reply threading/IDs.

Config (global default + per-channel overrides):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notes:

- Debounce applies to **text-only** messages; media/attachments flush immediately.
- Control commands bypass debouncing so they remain standalone.

## Sessions and devices

Sessions are owned by the gateway, not by clients.

- Direct chats use the agent main session key by default.
- Groups/channels get their own session keys.
- The session store and transcripts live on the gateway host.

`session.dmScope` can split direct chats by peer, channel, or account when you
want separate direct-message history. Multiple devices/channels can still map to
the same session, but history is not fully synced back to every client.
Recommendation: use one primary device for long conversations to avoid
divergent context. The Control UI and TUI always show the gateway-backed session
transcript, so they are the source of truth.

Details: [Session management](/concepts/session).

## Inbound bodies and history context

Fased separates agent prompt text from command parsing text:

- `BodyForAgent`: preferred prompt text sent to the Agent after channel cleanup.
- `BodyForCommands`: preferred text for directive/command parsing.
- `Body`: transport-level body or combined prompt fallback. This may include
  channel envelopes and optional history wrappers.
- `CommandBody` and `RawBody`: command-compatible fallbacks kept for older
  integrations.

When a channel supplies history, it uses a shared wrapper:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For **non-direct chats** (groups/channels/rooms), the **current message body** is prefixed with the
sender label (same style used for history entries). This keeps real-time and queued/history
messages consistent in the agent prompt.

History buffers are **pending-only**: they include group messages that did _not_
trigger a run (for example, mention-gated messages) and **exclude** messages
already in the session transcript.

Directive stripping only applies to the **current message** section so history
remains intact. Channels that wrap history should set `CommandBody` (or
`RawBody`) to the original message text and keep `Body` as the combined prompt.
History buffers are configurable via `messages.groupChat.historyLimit` (global
default) and per-channel overrides like `channels.slack.historyLimit` or
`channels.telegram.accounts.<id>.historyLimit` (set `0` to disable).

## Queueing and followups

If a run is already active, inbound messages can be queued, steered into the
current run, or collected for a followup turn.

- Configure via `messages.queue` and `messages.queue.byChannel`.
- Modes: `interrupt`, `steer`, `steer-backlog`, `followup`, and `collect`.
  Legacy `queue` config values normalize to `steer`.

Details: [Queueing](/concepts/queue).

## Streaming, chunking, and batching

Block streaming sends partial replies as the model produces text blocks.
Chunking respects channel text limits and avoids splitting fenced code.

Key settings:

- `agents.defaults.blockStreamingDefault` (`on|off`, default off)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (idle-based batching)
- `agents.defaults.humanDelay` (human-like pause between block replies)
- Channel/account overrides: `*.blockStreaming` and
  `*.blockStreamingCoalesce` where the channel supports them.

Details: [Streaming + chunking](/concepts/streaming).

## Reasoning visibility and tokens

Fased can expose or hide model reasoning:

- `/reasoning on|off|stream` controls visibility for the session.
- Reasoning content still counts toward token usage when produced by the model.
- Live reasoning stream output depends on model support and channel runtime; when
  unsupported, Fased keeps the setting but only shows reasoning where delivery
  supports it.

Details: [Thinking + reasoning directives](/tools/thinking) and [Token use](/reference/token-use).

## Prefixes, threading, and replies

Outbound message formatting is centralized in `messages`:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, and `channels.<channel>.accounts.<id>.responsePrefix` (outbound prefix cascade), plus `channels.whatsapp.messagePrefix` (WhatsApp inbound prefix)
- Reply threading via `replyToMode` and per-channel defaults

Details: [Configuration](/gateway/configuration#messages) and channel docs.
