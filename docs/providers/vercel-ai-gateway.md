---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway setup (auth + model selection)"
read_when:
  - You want to use Vercel AI Gateway with Fased
  - You need the API key env var or CLI auth choice
---

# Vercel AI Gateway

The [Vercel AI Gateway](https://vercel.com/ai-gateway) provides a unified API to access hundreds of models through a single endpoint.

- Provider: `vercel-ai-gateway`
- Auth: `AI_GATEWAY_API_KEY`
- API: OpenAI-compatible

## Quick start

1. Set the API key (recommended: store it for the Gateway):

```bash
fased onboard --auth-choice ai-gateway-api-key
```

2. Open **Agents**, select the Agent, then use **Agent > Models** to choose a
   Vercel AI Gateway model for primary, fallback, or task work.

For scripted setup, you can set the Agent default model in config:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/openai/gpt-5.5" },
    },
  },
}
```

## Non-interactive example

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `AI_GATEWAY_API_KEY`
is available to that process (for example, in `~/.fased/.env` or via
`env.shellEnv`).

## Model ID shorthand

Fased accepts common Vercel shorthand model refs and normalizes them at runtime:

- `vercel-ai-gateway/gpt-5.5` -> `vercel-ai-gateway/openai/gpt-5.5`
- `vercel-ai-gateway/claude-opus-4.7` -> `vercel-ai-gateway/anthropic/claude-opus-4.7`
