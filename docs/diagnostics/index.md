---
title: "Diagnostics"
summary: "Operator diagnostics map for Logs, Usage, Advanced views, traces, telemetry, and flags."
read_when:
  - You need to troubleshoot a running Fased gateway
  - You need to know whether to open Logs, Usage, Advanced > Debug, or Advanced > Nodes
  - You need targeted subsystem logs or diagnostic events without changing normal setup pages
---

# Diagnostics

Diagnostics are operator/admin surfaces. They help explain what the running
Gateway is doing after normal setup is complete.

Normal setup starts in the selected Agent:

- **Agent > Models** for model refs and roles.
- **Agent > Channels** for chat app accounts and routes.
- **Agent > Skills** for skill install, edit, config, and per-Agent access.
- **Agent > Tools** for per-Agent tool allow/deny.
- **Agent > Services** for external APIs such as web/search, Gmail, GitHub, and
  browser/media.
- **Agent > Memory** for session-memory and QMD state.

## Surfaces

- **Logs**: live gateway file logs, filter, auto-follow, export, and redacted
  troubleshooting evidence.
- **Usage**: local model usage history over the selected window by Agent,
  provider, model, session, task, channel/source, tokens, cache tokens, and cost
  when priced.
- **Advanced > Debug**: ordered status cards, status/health/model snapshots,
  plugin runtime diagnostics, provider catalog checks, memory repair preview,
  event log, and raw RPC inspection.
- **Advanced > Nodes**: paired device/runtime clients, pending pairings, command
  exposure, capabilities, permissions, and node last-seen state.
- **Advanced > Config**: raw `~/.fased/fased.json` escape hatch for settings
  that do not yet have a focused page.
- **Dashboard**: compact health widgets for quick checks. Use Logs, Usage, or
  Advanced diagnostics when you need detail.

## First Checks

When something looks wrong:

1. Check the top-bar health dot.
2. Open **Logs** and filter for the failing subsystem.
3. Open the focused page that owns the setting, for example **Agent >
   Services** for web/search credentials or **Agent > Channels** for a Telegram
   route.
4. Open **Advanced > Debug** only when you need raw status snapshots, plugin
   runtime diagnostics, or Memory Doctor repair preview.
5. Open **Advanced > Nodes** only when device pairing or node capabilities are
   involved.

## Usage vs Quota

**Usage** is local accounting for model calls Fased made. It prefers transcript
and task run-log usage records, then falls back only when a better source is not
available. Provider account quota/status is separate and belongs to provider
auth/status surfaces, not local usage history.

## Diagnostic Flags

Diagnostic flags are targeted log switches. Use them when normal Logs output is
not enough, but avoid raising global logging to trace for every subsystem.

- Configure flags in **Advanced > Config** under `diagnostics.flags`, or use the
  `FASED_DIAGNOSTICS` environment override for one run.
- Flags only do something when code checks that exact flag. The current
  code-backed operator flag is `telegram.http`; wildcards such as `telegram.*`
  match it.
- Reproduce the issue.
- Read the output in **Logs** or with `fased logs --follow`.

See [Diagnostics Flags](/diagnostics/flags).

## Structured Diagnostics

Structured diagnostics are separate from diagnostic flags. Set
`diagnostics.enabled: true` when you need in-process diagnostic events for model
usage, webhooks, queues, session state, stuck-session detection, and tool-loop
warnings. **Advanced > Debug** reads the diagnostic stability snapshot through
`diagnostics.stability`.

OpenTelemetry export is another layer. It requires:

- the bundled `diagnostics-otel` extension enabled and loaded;
- `diagnostics.enabled: true`;
- `diagnostics.otel.enabled: true`.

The exporter currently uses OTLP/HTTP. See [Logging](/gateway/logging) for the full
OpenTelemetry setup.

## Prometheus

Prometheus belongs under **Advanced > Debug**, not normal setup. Enable
`diagnostics.prometheus.enabled` when a hosted gateway needs a lightweight
scrape endpoint.

Default endpoint:

```text
GET /metrics
```

Remote clients must authenticate by default. Local loopback scrapes are allowed
for operator tooling. The endpoint intentionally exposes only low-cardinality
runtime and diagnostic gauges, for example gateway uptime, memory usage,
readiness, retained diagnostic events, and dropped diagnostic events.

Example config:

```json5
{
  diagnostics: {
    enabled: true,
    prometheus: {
      enabled: true,
      path: "/metrics",
      requireAuth: true,
      includeRuntime: true,
    },
  },
}
```

## Cache Trace

Cache trace is a temporary, high-detail diagnostic for embedded agent runs. It is
separate from normal Logs and from diagnostic flags.

- Config path: `diagnostics.cacheTrace`.
- Env override: `FASED_CACHE_TRACE=1`.
- Default file: `$FASED_STATE_DIR/logs/cache-trace.jsonl`.

Cache trace can include messages, prompt text, and system text. Enable it only
while reproducing a cache/context issue, then turn it off.

## Related

- [Debug](/debug/index)
- [Gateway logging](/gateway/logging)
- [Logging and OpenTelemetry](/gateway/logging)
- [Usage tracking](/concepts/usage-tracking)
- [Nodes](/nodes/index)
- [Memory Doctor](/concepts/memory-doctor)
