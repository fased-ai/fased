---
summary: "Logging surfaces, file logs, WS log styles, and console formatting"
read_when:
  - Changing logging output or formats
  - Debugging CLI or gateway output
title: "Logging"
---

# Logging

For the operator-facing route map, see [Diagnostics](/diagnostics/index).

Fased has two log “surfaces”:

- **Console output** (what you see in the terminal or process manager).
- **File logs** (JSON lines) written by the gateway logger.

## File-based logger

- Default rolling log file is under `/tmp/fased/` (one file per day): `fased-YYYY-MM-DD.log`
  - Date uses the gateway host's local timezone.
- The log file path and level can be configured via `~/.fased/fased.json`:
  - `logging.file`
  - `logging.level`
  - `logging.maxFileBytes` (single-file cap; default 500 MB)

The file format is one JSON object per line.

The browser **Logs** page tails this file via the gateway (`logs.tail`).
CLI can do the same:

```bash
fased logs --follow
```

**Verbose vs. log levels**

- **File logs** are controlled exclusively by `logging.level`.
- `--verbose` only affects **console verbosity** (and WS log style); it does **not**
  raise the file log level.
- To capture verbose-only details in file logs, set `logging.level` to `debug` or
  `trace`.

## Control UI Boundary

- Use **Logs** for live tail, filter, auto-follow, and export.
- Use **Advanced > Debug** for status/health/model snapshots, plugin runtime
  diagnostics, memory repair preview, event log, and raw RPC inspection.
- Use **Advanced > Config** only when changing raw logging config that does not
  have a friendlier control yet.

## Console capture

The CLI captures `console.log/info/warn/error/debug/trace` and writes them to file logs,
while still printing to stdout/stderr.

You can tune console verbosity independently via:

- `logging.consoleLevel` (default `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Redaction boundary

Verbose tool summaries (e.g. `🛠️ Exec: ...`) can mask sensitive tokens before they hit the
console stream. This is best-effort redaction for tool/status text, not a complete
security boundary for every log source.

- `logging.redactSensitive`: `off` | `tools` (default: `tools`)
- `logging.redactPatterns`: array of regex strings (overrides defaults)
  - Use raw regex strings (auto `gi`), or `/pattern/flags` if you need custom flags.
  - Matches are masked by keeping the first 6 + last 4 chars (length >= 18), otherwise `***`.
  - Defaults cover common key assignments, CLI flags, JSON fields, bearer headers, PEM blocks, and popular token prefixes.

Review debug/trace logs before sharing them. Channel adapters and HTTP clients may
include message previews, request summaries, or provider error bodies when verbose
logging is enabled.

## Gateway WebSocket logs

The gateway prints WebSocket protocol logs in two modes:

- **Normal mode (no `--verbose`)**: only “interesting” RPC results are printed:
  - errors (`ok=false`)
  - slow calls (default threshold: `>= 50ms`)
  - parse errors
- **Verbose mode (`--verbose`)**: prints all WS request/response traffic.

### WS log style

`fased gateway` supports a per-gateway style switch:

- `--ws-log auto` (default): normal mode is optimized; verbose mode uses compact output
- `--ws-log compact`: compact output (paired request/response) when verbose
- `--ws-log full`: full per-frame output when verbose
- `--compact`: alias for `--ws-log compact`

Examples:

```bash
# optimized (only errors/slow)
fased gateway

# show all WS traffic (paired)
fased gateway --verbose --ws-log compact

# show all WS traffic (full meta)
fased gateway --verbose --ws-log full
```

## Console formatting (subsystem logging)

The console formatter is **TTY-aware** and prints consistent, prefixed lines.
Subsystem loggers keep output grouped and scannable.

Behavior:

- **Subsystem prefixes** on every line (e.g. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Subsystem colors** (stable per subsystem) plus level coloring
- **Color** when output is a TTY or the environment looks like a rich terminal
  (`TERM`, `COLORTERM`, `TERM_PROGRAM`); respects `NO_COLOR`
- **Shortened subsystem prefixes**: drops leading `gateway/` + `channels/`,
  keeps last 2 segments, for example `whatsapp/outbound`
- **Sub-loggers by subsystem** (auto prefix + structured field `{ subsystem }`)
- **`logRaw()`** for QR/UX output (no prefix, no formatting)
- **Console styles** (e.g. `pretty | compact | json`)
- **Console log level** separate from file log level. File logs keep full detail
  when `logging.level` is set to `debug`/`trace`.
- **Debug/trace channel logs may include message previews or adapter details**;
  review before sharing.

This keeps existing file logs stable while making interactive output scannable.
