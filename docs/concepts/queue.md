---
summary: "Command queue design for inbound runs, session lanes, and followup handling."
read_when:
  - Changing auto-reply execution or concurrency
title: "Command Queue"
---

# Command Queue

Fased uses small in-process queues to keep agent runs ordered where ordering
matters, while still allowing safe parallelism across sessions.

## Why

- Auto-reply runs can be expensive and can collide when multiple inbound
  messages arrive close together.
- Serializing avoids competing for shared resources such as session files,
  logs, and CLI stdin. It also reduces the chance of upstream rate limits.

## How it works

- A lane-aware FIFO queue drains each lane with a configurable concurrency cap.
- Unconfigured lanes default to `1`; `main` defaults to `4`; `subagent`
  defaults to `8`; `cron` uses `cron.maxConcurrentRuns` and defaults to `1`.
- The embedded Agent runtime first enters a **session lane**
  (`session:<key>`) so only one active run touches a session at a time.
- Each session run then enters a **global lane** (`main` by default) so overall
  parallelism is capped by `agents.defaults.maxConcurrent`.
- When diagnostic logging is enabled, queued runs log when they waited more
  than about 2 seconds before starting.
- Typing indicators start according to the run's typing mode when a run begins.
  Followup messages waiting in the queue do not keep typing alive by themselves.

## Queue modes (per channel)

Inbound messages can steer the current run, wait for a followup turn, or do both:

- `steer`: inject immediately into the current run and cancel pending tool
  calls after the next tool boundary. If the run is not streaming, it falls back
  to followup.
- `followup`: enqueue for the next agent turn after the current run ends.
- `collect`: coalesce all queued messages into a **single** followup turn
  (default). If messages target different channels/threads, they drain
  individually to preserve routing.
- `steer-backlog` (aka `steer+backlog`): steer now **and** preserve the message for a followup turn.
- `interrupt` (legacy): clear pending work for the session lane, abort the
  active embedded run, then run the newest message.
- `queue` (legacy alias): same as `steer`.

Steer-backlog means you can get a followup response after the steered run, so
streaming surfaces can look like duplicates. Prefer `collect`/`steer` if you want
one response per inbound message.
Send `/queue collect` as a standalone command for the current session, or set
`messages.queue.byChannel.discord: "collect"`.

Defaults (when unset in config):

- All surfaces: `collect`

Configure globally or per channel via `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      debounceMsByChannel: { discord: 1000 },
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Queue options

Options apply to `followup`, `collect`, and `steer-backlog` (and to `steer`
when it falls back to followup):

- `debounceMs`: wait for quiet before starting a followup turn.
- `cap`: max queued messages per session.
- `drop`: overflow policy (`old`, `new`, `summarize`).

Summarize keeps a short bullet list of dropped messages and injects it as a
synthetic followup prompt.
Defaults: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Per-session overrides

- Send `/queue <mode>` as a standalone command to store the mode for the current session.
- Options can be combined: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` or `/queue reset` clears the session override.

## Scope and behavior

- Applies to auto-reply agent runs across inbound channels that use the gateway
  reply pipeline.
- Default lane (`main`) is process-wide for inbound + main heartbeats. Set
  `agents.defaults.maxConcurrent` to allow multiple sessions in parallel.
- Additional lanes may exist, such as `cron` and `subagent`, so background jobs
  can run in parallel without blocking inbound replies.
- Per-session lanes keep one agent run active for a given session at a time.
- No external dependencies or background worker threads; pure TypeScript + promises.

## Troubleshooting

- If commands seem stuck, enable diagnostic or verbose logs and look for lane
  wait/dequeue lines to confirm the queue is draining.
- If you need queue depth, enable verbose logs and watch for queue timing lines.
