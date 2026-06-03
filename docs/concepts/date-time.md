---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
title: "Date and Time"
---

# Date & Time

Fased keeps runtime time handling split by purpose:

- Channel message envelopes use a configurable envelope timezone. The default is the host timezone.
- Direct Gateway messages are timestamped with the resolved user timezone.
- The system prompt includes the user timezone only, not a live clock.
- Provider timestamps are preserved in tool payloads, with normalized UTC fields added where supported.

When the agent needs the current time, it should call `session_status`.

## Message envelopes (local by default)

Inbound messages are wrapped with a timestamp (minute precision):

```
[Provider ... Mon 2026-01-05 16:26 PST] message text
```

This envelope timestamp is host-local by default, regardless of the provider timezone.

You can override this behavior:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` uses UTC.
- `envelopeTimezone: "local"` uses the host timezone.
- `envelopeTimezone: "user"` uses `agents.defaults.userTimezone` (falls back to host timezone).
- Use an explicit IANA timezone (e.g., `"America/Chicago"`) for a fixed zone.
- `envelopeTimestamp: "off"` removes absolute timestamps from envelope headers.
- `envelopeElapsed: "off"` removes elapsed time suffixes (the `+2m` style).

### Examples

**Local envelope (default):**

```
[WhatsApp +1555 Sun 2026-01-18 00:19 PST] hello
```

**User-timezone envelope:**

```
[WhatsApp +1555 Sun 2026-01-18 02:19 CST] hello
```

**Elapsed time enabled:**

```
[WhatsApp +1555 +30s Sun 2026-01-18T08:19Z] follow-up
```

## System prompt: Current Date & Time

If the user timezone is known, the system prompt includes a dedicated **Current Date & Time** section with the time zone only. It intentionally does not include the current clock time, day, or date, so prompt caching stays stable:

```
Time zone: America/Chicago
```

The prompt also tells the agent to use `session_status` when it needs the current date, time, or day of week. The status card includes a timestamp line.

## Direct Gateway messages

Messages sent through direct Gateway paths, including `agent` and `chat.send`, receive a compact timestamp prefix unless they already have one:

```
[Wed 2026-01-28 19:30 CST] hello
```

These prefixes use `agents.defaults.userTimezone` after validation. If no user timezone is configured, Fased resolves the host timezone at runtime and falls back to `UTC` only if the host cannot provide one.

## System event lines (local by default)

Queued system events inserted into agent context are prefixed with a timestamp using the
same timezone selection as message envelopes (default: host-local).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Configure user timezone + format

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` sets the user-local timezone used for prompt context, direct Gateway timestamp injection, `session_status`, and cron-style current-time lines.
- `timeFormat` controls 12h/24h display in `session_status` and cron-style current-time lines. `auto` follows OS prefs.

## Time format detection (auto)

When `timeFormat: "auto"`, Fased inspects the OS preference (macOS/Windows)
and falls back to locale formatting. The detected value is **cached per process**
to avoid repeated system calls.

## Tool payloads + connectors (raw provider time + normalized fields)

Channel tools return provider-native timestamps and add normalized fields for consistency where the connector has a timestamp to normalize:

- `timestampMs`: epoch milliseconds (UTC)
- `timestampUtc`: ISO 8601 UTC string

Raw provider fields are preserved so nothing is lost.

- Slack: epoch-like strings from the API
- Discord: UTC ISO timestamps
- Telegram/WhatsApp: provider-specific numeric/ISO timestamps

If you need local time, convert it downstream using the known timezone.

## Related docs

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
