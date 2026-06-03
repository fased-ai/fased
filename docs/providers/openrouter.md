---
summary: "Use OpenRouter's unified API to access many models in Fased"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in Fased
title: "OpenRouter"
---

# OpenRouter

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL to
`https://openrouter.ai/api/v1`.

## CLI setup

```bash
fased onboard --auth-choice openrouter-api-key --openrouter-api-key "$OPENROUTER_API_KEY"
```

The same API-key method is available in **Agent > Models** and through the CLI.
Open **Agents**, select the Agent, then choose **OpenRouter** in the Models
tab. OpenRouter does not have a separate first-party OAuth method in Fased.

## Config snippet

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/auto" },
    },
  },
}
```

## Notes

- Model refs are `openrouter/<provider>/<model>`.
- `openrouter/auto` is the guided setup default. Normal pickers show a curated current model list and
  can still use OpenRouter's dynamic model catalog when the runtime reports it.
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- OpenRouter uses a Bearer token with your API key under the hood.
