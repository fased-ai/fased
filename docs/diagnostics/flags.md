---
summary: "Code-backed targeted diagnostic log flags for Logs and Advanced troubleshooting"
read_when:
  - You need targeted debug logs without raising global logging levels
  - You need to capture subsystem-specific logs for support
title: "Diagnostics Flags"
---

# Diagnostics Flags

Diagnostics flags let you enable targeted debug logs without turning on verbose
logging everywhere. Flags are opt-in and have no effect unless Fased code checks
that exact flag.

Use flags as an operator diagnostic tool:

1. Enable the narrow flag in **Advanced > Config** or with the environment
   override below.
2. Reproduce the issue.
3. Read the output in **Logs** or `fased logs --follow`.

Do normal setup in focused pages first. For example, use **Agent > Channels** for
Telegram route setup and **Agent > Services** for web/search credentials; use
diagnostic flags only when those pages do not explain the failure.

## How it works

- Flags are strings (case-insensitive).
- You can enable flags in config or via an env override.
- Config flags and env flags are merged.
- Wildcards are supported:
  - `telegram.*` matches `telegram.http`
  - `*` enables all flags

Current code-backed flag:

| Flag            | Emits                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| `telegram.http` | Telegram send failures with HTTP status, Telegram error code, retry-after, and description. |

Do not add random flag names expecting output. A flag is useful only when the
running code checks it.

## Enable via Advanced Config

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Wildcard example:

```json
{
  "diagnostics": {
    "flags": ["telegram.*"]
  }
}
```

Set this in **Advanced > Config** when no friendlier diagnostic toggle exists.
Restart the gateway after changing flags.

## Env override (one-off)

```bash
FASED_DIAGNOSTICS=telegram.http
```

Multiple flags can be separated by commas or spaces:

```bash
FASED_DIAGNOSTICS="telegram.http cache.*"
```

Use `1`, `true`, `all`, or `*` to enable every code-backed diagnostic flag for
that process.

Disable env-provided flags for that process:

```bash
FASED_DIAGNOSTICS=0
```

`false`, `off`, and `none` are also treated as disabled. This does not erase
flags already stored in `diagnostics.flags`. Remove stored config flags from
**Advanced > Config** if you want no configured flags.

## Where Logs Show Up

Flags emit logs into the standard gateway log file. By default this is the
current dated file in the Fased temp log directory, normally:

```
/tmp/fased/fased-YYYY-MM-DD.log
```

If you set `logging.file`, use that path instead. Logs are JSONL (one JSON
object per line). Redaction still applies based on `logging.redactSensitive`.

The browser **Logs** page tails the same file through the Gateway. Use
**Advanced > Debug** for status snapshots and raw RPC checks; use **Logs** for
streaming log evidence.

## Extract logs

Filter for Telegram HTTP diagnostics:

```bash
rg "telegram http error" /tmp/fased/fased-*.log
```

Tail the current dated log while reproducing:

```bash
tail -f /tmp/fased/fased-$(date +%F).log | rg "telegram http error"
```

For remote gateways, you can also use `fased logs --follow` (see
[/cli/logs](/cli/logs)).

## Notes

- Telegram HTTP diagnostic logs are emitted at `warn`. If `logging.level` is
  `error`, `fatal`, or `silent`, they may be suppressed. Default `info` is fine.
- Flags are usually safe to leave enabled, but they can increase log volume for
  the specific subsystem.
- Structured diagnostic events are separate. Set `diagnostics.enabled: true` for
  event snapshots in **Advanced > Debug** and for diagnostic event subscribers.
- Cache trace is separate. Use `diagnostics.cacheTrace.enabled` or
  `FASED_CACHE_TRACE=1` only while debugging cache/context behavior because it
  can write prompt, message, and system text to JSONL.
- OpenTelemetry export is separate. It requires the `diagnostics-otel` extension
  plus `diagnostics.enabled` and `diagnostics.otel.enabled`.
- Use [Gateway logging](/gateway/logging) to change log destinations, levels,
  and redaction.
