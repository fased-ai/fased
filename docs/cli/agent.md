---
summary: "Run one agent turn from the CLI through the gateway or embedded local mode."
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
title: "agent"
---

# `fased agent`

Run one agent turn without opening the full UI. By default it goes through the
gateway; use `--local` when you intentionally want the embedded local path.
Use `--agent <id>` to target a configured agent directly.

The command needs a session target:

- `--to <E.164>` derives a sender-style session key.
- `--session-id <id>` reuses a known session id.
- `--agent <id>` uses that agent's default session key.

Use `--deliver` only when you want Fased to send the reply back through a
channel. For a new CLI-triggered delivery, pass `--channel` or
`--reply-channel`; otherwise delivery can only reuse a main session that already
has channel context.

Related:

- Agent send tool: [Agent send](/tools/agent-send)

## Examples

```bash
fased agent --to +15555550123 --message "status update"
fased agent --agent ops --message "Summarize logs"
fased agent --session-id 1234 --message "Summarize inbox" --thinking medium
fased agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
fased agent --to +15555550123 --message "Send a status update" --deliver --channel whatsapp
```

## Useful flags

- `--message <text>`: required message body.
- `--agent <id>`: target a configured agent.
- `--to <E.164>`: derive a session from a sender/recipient number.
- `--session-id <id>`: reuse a known session id.
- `--thinking <level>`: `off`, `minimal`, `low`, `medium`, or `high`.
- `--verbose <on|off>`: persist verbose output for the session.
- `--channel <channel>`: delivery channel for `--deliver`.
- `--reply-channel <channel>` / `--reply-to <target>`: override delivery
  without changing routing.
- `--reply-account <id>`: delivery account override.
- `--local`: skip the gateway and run embedded locally.
- `--json`: print the gateway result envelope.
- `--timeout <seconds>`: command timeout; `0` means no timeout.
