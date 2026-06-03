---
summary: "When Fased shows typing indicators and how to tune their timing and mode."
read_when:
  - Changing typing indicator behavior or defaults
title: "Typing Indicators"
---

# Typing indicators

Typing indicators are sent to the chat channel while a run is active. Use
`agents.defaults.typingMode` to control **when** typing starts and `typingIntervalSeconds`
to control **how often** it refreshes.

## Defaults

When `agents.defaults.typingMode` is unset, Fased keeps the legacy behavior:

- **Direct chats**: typing starts immediately once the model loop begins.
- **Group chats with a mention**: typing starts immediately.
- **Group chats without a mention**: typing starts only when message text begins streaming.
- **Heartbeat runs**: typing is disabled.

## Modes

Set `agents.defaults.typingMode` to one of:

- `never` — no typing indicator, ever.
- `instant` — start typing **as soon as the model loop begins**, even if the run
  later returns only the silent reply token.
- `thinking` — delay run-start typing and start when the run produces
  renderable text/reasoning activity. It is most useful with
  `reasoningLevel: "stream"`.
- `message` — start typing on the **first non-silent text delta** (ignores
  the `NO_REPLY` silent token).

In normal text-only runs, `message` and `thinking` wait for visible activity;
`instant` starts at run start. Tool activity can start typing earlier in any
enabled mode.

## Configuration

```json5
{
  agents: {
    defaults: {
      typingMode: "thinking",
      typingIntervalSeconds: 6,
    },
  },
}
```

You can override mode or cadence per session:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notes

- `message` mode won’t show typing for silent-only replies (e.g. the `NO_REPLY`
  token used to suppress output).
- Tool execution can start or refresh typing in any enabled mode so channels do
  not look idle during a visible tool-backed response.
- `thinking` is best with streamed reasoning. If the model does not emit
  reasoning deltas, visible text can still start typing once renderable output
  exists.
- Heartbeats never show typing, regardless of mode.
- `typingIntervalSeconds` controls the **refresh cadence**, not the start time.
  The default is 6 seconds.
