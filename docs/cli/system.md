---
summary: "Enqueue system events, manage heartbeat behavior, and inspect runtime presence."
read_when:
  - You want to enqueue a system event without creating a scheduled task
  - You need to enable or disable heartbeats
  - You want to inspect system presence entries
title: "system"
---

# `fased system`

System-level helpers for the gateway: enqueue system events, control heartbeats, and inspect presence.

## Common commands

```bash
fased system event --text "Check for urgent follow-ups" --mode now
fased system event --text "Check for urgent follow-ups" --json
fased system heartbeat enable
fased system heartbeat last
fased system presence
fased system presence --json
```

All subcommands accept Gateway client overrides such as `--url <url>`,
`--token <token>`, and `--timeout <ms>` when you need to call a non-default
Gateway.

## `system event`

Enqueue a system event on the **main** session. The next heartbeat will inject
it as a `System:` line in the prompt. Use `--mode now` to trigger the heartbeat
immediately; `next-heartbeat` waits for the next scheduled tick.

Flags:

- `--text <text>`: required system event text.
- `--mode <mode>`: `now` or `next-heartbeat` (default).
- `--json`: machine-readable output.

## `system heartbeat last|enable|disable`

Heartbeat controls:

- `last`: show the last heartbeat event.
- `enable`: turn heartbeats back on (use this if they were disabled).
- `disable`: pause heartbeats.

Flags:

- `--json`: machine-readable output.

## `system presence`

List the current system presence entries the Gateway knows about (nodes,
instances, and similar status lines).

Flags:

- `--json`: machine-readable output.

## Notes

- Requires a running Gateway reachable by your current config (local or remote).
- System events are ephemeral and not persisted across restarts.
