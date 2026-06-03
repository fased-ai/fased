---
summary: "Open the terminal UI connected to a local or remote Fased gateway."
read_when:
  - You want a terminal UI for the Gateway (remote-friendly)
  - You want to pass url/token/session from scripts
title: "tui"
---

# `fased tui`

Open the terminal UI connected to the gateway.

Related:

- TUI guide: [TUI](/web/tui)

## Examples

```bash
fased tui
fased tui --url ws://127.0.0.1:18789 --token <token>
fased tui --session main --deliver
fased tui --message "Summarize this session" --thinking medium
```

## Options

- `--url <url>`: Gateway WebSocket URL.
- `--token <token>` / `--password <password>`: Gateway auth.
- `--session <key>`: session key to open.
- `--deliver`: deliver assistant replies through the session route.
- `--thinking <level>`: thinking level override.
- `--message <text>`: send an initial message after connecting.
- `--timeout-ms <ms>`: agent timeout override.
- `--history-limit <n>`: transcript entries to load.
