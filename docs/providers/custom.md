---
title: "Custom Provider"
summary: "Custom OpenAI-compatible or Anthropic-compatible endpoint setup"
read_when:
  - You want to connect a self-hosted or third-party model endpoint
  - You need a custom base URL, model ID, or compatibility mode
---

# Custom Provider

Custom Provider is for endpoints that are not one of Fased's built-in provider
cards. It supports OpenAI-compatible and Anthropic-compatible APIs.

Use this when you have:

- a base URL
- a model ID served by that endpoint
- endpoint compatibility: OpenAI or Anthropic
- an optional API key
- explicit private-network approval if the URL is local or private

## Quick start

Normal browser setup is **Agents > selected Agent > Models > Custom Provider**.
Use the CLI path below when you want a repeatable setup command or need to
script local/private endpoint creation.

```bash
fased onboard --auth-choice custom-api-key
```

The wizard asks for the endpoint URL, API shape, model ID, optional API key,
endpoint ID, and optional model alias. It verifies the endpoint before writing
the provider config.

## Non-interactive example

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice custom-api-key \
  --custom-base-url "https://models.example.com/v1" \
  --custom-model-id "my-model" \
  --custom-compatibility openai \
  --custom-api-key "$CUSTOM_API_KEY"
```

For local or private endpoints, add:

```bash
--allow-private-network
```

## Config shape

Custom setup writes a provider entry and sets the selected model as the Agent
default.

```json5
{
  models: {
    mode: "merge",
    providers: {
      "models-example-com": {
        baseUrl: "https://models.example.com/v1",
        api: "openai-completions",
        apiKey: "${CUSTOM_API_KEY}",
        models: [
          {
            id: "my-model",
            name: "my-model (Custom Provider)",
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "models-example-com/my-model" },
    },
  },
}
```

## UI status

**Agent > Models** shows Custom Provider in the same onboarding order. Use it
to enter the base URL, compatibility mode, model ID, optional API key, and
private-network approval for the selected Agent.

Use onboarding, CLI flags, or **Advanced > Config** when you need to automate or
bulk-edit custom provider entries. Keep normal credential entry and model role
selection in **Agent > Models**.
