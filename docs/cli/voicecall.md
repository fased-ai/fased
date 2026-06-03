---
summary: "Use the voice-call plugin command surface when that plugin is installed."
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `fased voicecall`

`voicecall` is a plugin-provided command surface. It only appears when the voice-call plugin is installed and enabled.

Primary doc:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
fased voicecall status --call-id <id>
fased voicecall call --to "+15555550123" --message "Hello" --mode notify
fased voicecall start --to "+15555550123" --message "Hello"
fased voicecall continue --call-id <id> --message "Any questions?"
fased voicecall speak --call-id <id> --message "One-way update."
fased voicecall end --call-id <id>
fased voicecall tail --since 50
fased voicecall latency --last 100
```

`call` and `start` support `--mode notify` for a one-way notification or
`--mode conversation` to keep the call open.

`tail` supports `--file <path>`, `--since <n>`, and `--poll <ms>` for provider
tests and troubleshooting.

`latency` reads the same JSONL log and summarizes recent turn latency.

## Exposing webhooks (Tailscale)

```bash
fased voicecall expose --mode serve
fased voicecall expose --mode funnel
fased voicecall expose --mode off
```

`expose` also accepts `--path`, `--port`, and `--serve-path` when the webhook
route differs from the plugin config.

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
