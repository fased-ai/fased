---
summary: "xAI setup"
title: "xAI"
read_when:
  - You want to use Grok models
  - You need the provider id, sign-in flow, or API key env var
---

# xAI

Fased supports xAI Grok models through an OpenAI-compatible API. In the Control
UI, open **Agent > Models** and use the xAI card.

| Property    | Value                 |
| ----------- | --------------------- |
| Provider id | `xai`                 |
| Auth env    | `XAI_API_KEY`         |
| API         | OpenAI-compatible     |
| Base URL    | `https://api.x.ai/v1` |

Setup methods:

- **xAI sign-in**: browser OAuth for eligible xAI/Grok accounts.
- **xAI device code**: remote-friendly sign-in for hosted or SSH sessions.
- **xAI API key**: paste `XAI_API_KEY` or set it in the gateway environment.

Use device code when the gateway is on a VPS or you are connected over
Tailscale/SSH and cannot rely on a localhost browser callback.

Example default model:

```json5
{
  agents: { defaults: { model: { primary: "xai/grok-4.3" } } },
}
```

Normal first-run surfaces show the current Chat API models:

- `xai/grok-4.3`
- `xai/grok-4.20-multi-agent-0309`
- `xai/grok-4.20-0309-reasoning`
- `xai/grok-4.20-0309-non-reasoning`

Older Grok 4, Grok 4 Fast, Grok 4.1 Fast, Grok 3, and Grok Code Fast models
are not shown in normal setup because xAI is retiring those API models on May
15, 2026. Existing explicit configs are not removed automatically.

Run `fased models list --all --provider xai` to see the full runtime catalog.
