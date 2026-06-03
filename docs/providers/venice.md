---
summary: "Use Venice AI models in Fased"
read_when:
  - You want to use Venice AI from Fased
  - You need Venice API key setup guidance
title: "Venice AI"
---

# Venice AI

Venice AI exposes an OpenAI-compatible model API. Fased registers it as the
`venice` provider, discovers the Venice model list when the API is reachable,
and lets each Agent choose Venice for primary, fallback, or task model roles.

- Provider: `venice`
- Auth: `VENICE_API_KEY`
- API: OpenAI-compatible
- Base URL: `https://api.venice.ai/api/v1`
- Default model ref: `venice/zai-org-glm-5-1`

## Quick Start

1. Create an API key at [venice.ai](https://venice.ai).
2. Open **Agents**, select the Agent, then use **Agent > Models > Venice AI**.
3. Paste the API key and choose that Agent's model roles.

CLI setup:

```bash
fased onboard --auth-choice venice-api-key
```

Non-interactive setup:

```bash
fased onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "$VENICE_API_KEY"
```

Verify:

```bash
fased agent --model venice/zai-org-glm-5-1 --message "Hello, are you working?"
```

## Model Selection

Use **Agent > Models** as the source of truth for the current Venice catalog.
The runtime starts with Fased's checked-in model metadata, then can refresh from
the Venice API when credentials and network access are available.

Common refs in the current Fased catalog include:

| Ref                                           | Use                         |
| --------------------------------------------- | --------------------------- |
| `venice/zai-org-glm-5-1`                      | Default Venice model ref    |
| `venice/qwen3-coder-480b-a35b-instruct-turbo` | Coding-heavy tasks          |
| `venice/qwen3-vl-235b-a22b`                   | Vision-capable route        |
| `venice/deepseek-v4-pro`                      | Reasoning route             |
| `venice/kimi-k2-6`                            | Kimi route                  |
| `venice/claude-opus-4-7`                      | Claude route through Venice |
| `venice/openai-gpt-55`                        | OpenAI route through Venice |
| `venice/gemini-3-1-pro-preview`               | Gemini route through Venice |
| `venice/grok-4-20`                            | Grok route through Venice   |
| `venice/openai-gpt-oss-120b`                  | Open-weight route           |

Set an Agent model from the CLI when needed:

```bash
fased models set venice/zai-org-glm-5-1
fased models list | grep venice
```

## Privacy And Routing

Venice publishes model-specific privacy and routing modes. Treat **Agent >
Models** and Venice's own account/model documentation as the authority for the
current mode, pricing, availability, and provider route. Fased records the model
ref you select and sends requests to the configured Venice API endpoint; it does
not change Venice's upstream policy.

## Config Example

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: {
    defaults: {
      model: { primary: "venice/zai-org-glm-5-1" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
      },
    },
  },
}
```

## Notes

- Inference requires a valid `VENICE_API_KEY`.
- If the Gateway runs under systemd or launchd, make sure `VENICE_API_KEY` is
  available to that process or stored through the Fased auth/config flow.
- Some models may be renamed, added, removed, or temporarily unavailable by the
  provider. Use **Agent > Models** to check the currently reachable catalog.
- Check [Venice pricing](https://venice.ai/pricing), [API docs](https://docs.venice.ai),
  and [status](https://status.venice.ai) for provider-side details.
