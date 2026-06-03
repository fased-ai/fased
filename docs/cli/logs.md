---
summary: "Tail or fetch gateway logs over RPC without shelling into the host."
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `fased logs`

Tail gateway file logs over RPC. This is the quick path when the runtime is remote and you do not want to SSH into the host just to inspect logs.

Related:

- Diagnostics map: [Diagnostics](/diagnostics/index)
- Gateway logging: [Gateway logging](/gateway/logging)

## Examples

```bash
fased logs
fased logs --follow
fased logs --json
fased logs --limit 500
fased logs --max-bytes 500000
fased logs --local-time
fased logs --follow --local-time
fased logs --follow --interval 2000
```

Use `--local-time` to render timestamps in your local timezone.

## Options

- `--limit <n>`: max lines to return per fetch.
- `--max-bytes <n>`: max bytes to read from the log file.
- `--follow`: keep polling for new log lines.
- `--interval <ms>`: polling interval while following.
- `--json`: emit newline-delimited JSON records.
- `--plain`: plain text output with no pretty formatting.
- `--no-color`: disable ANSI colors.
- `--local-time`: render timestamps in local time instead of UTC.
- `--url <url>`: explicit Gateway WebSocket URL.
- `--token <token>`: Gateway token for that target.
- `--timeout <ms>`: Gateway RPC timeout.
- `--expect-final`: wait for a final Gateway response.

Browser equivalent: open **Logs** for live tail, filter, auto-follow, and
export. Use **Advanced > Debug** for status snapshots and raw RPC inspection.
