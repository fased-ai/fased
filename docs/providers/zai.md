---
summary: "Use Z.AI (GLM models) with Fased"
read_when:
  - You want Z.AI / GLM models in Fased
  - You need a simple ZAI_API_KEY setup
title: "Z.AI"
---

# Z.AI

Z.AI is the API platform for **GLM** models. It provides REST APIs for GLM and uses API keys
for authentication. Create your API key in the Z.AI console. Fased uses the `zai` provider
with a Z.AI API key.

## CLI setup

```bash
fased onboard --auth-choice zai-api-key
# or non-interactive
fased onboard --zai-api-key "$ZAI_API_KEY"
```

## Config snippet

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
}
```

## Notes

- GLM models are available through the Z.AI provider as `zai/<model>` (example:
  `zai/glm-5.1`).
- Current first-run choices are `glm-5.1`, `glm-5`, `glm-5-turbo`,
  `glm-4.7`, `glm-4.7-flashx`, and `glm-4.7-flash`.
- `tool_stream` is enabled by default for Z.AI tool-call streaming. Set
  `agents.defaults.models["zai/<model>"].params.tool_stream` to `false` to disable it.
- Z.AI uses Bearer auth with your API key.
