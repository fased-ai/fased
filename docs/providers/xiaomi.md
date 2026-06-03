---
summary: "Use Xiaomi MiMo models with Fased"
read_when:
  - You want Xiaomi MiMo models in Fased
  - You need XIAOMI_API_KEY setup
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo is the API platform for **MiMo** models. It provides REST APIs compatible with
OpenAI and Anthropic formats and uses API keys for authentication. Create your API key in
the [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys). Fased uses
the `xiaomi` provider with a Xiaomi MiMo API key.

## Model overview

- **mimo-v2.5-pro**: current default, reasoning + image input, 1M-token context.
- **mimo-v2.5**: current balanced model, reasoning + image input, 1M-token context.
- **mimo-v2-pro**: large-context reasoning text model.
- **mimo-v2-omni**: multimodal model with text and image input.
- **mimo-v2-flash**: fast lower-cost text model.
- Base URL: `https://api.xiaomimimo.com/v1`
- API: OpenAI-compatible chat completions.
- Authorization: `Bearer $XIAOMI_API_KEY`

## CLI setup

```bash
fased onboard --auth-choice xiaomi-api-key
# or non-interactive
fased onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Config snippet

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2.5-pro" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2.5-pro",
            name: "Xiaomi MiMo V2.5 Pro",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 131072,
          },
        ],
      },
    },
  },
}
```

## Notes

- Default model ref: `xiaomi/mimo-v2.5-pro`.
- Fast model ref: `xiaomi/mimo-v2-flash`.
- The provider is injected automatically when `XIAOMI_API_KEY` is set (or an auth profile exists).
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
