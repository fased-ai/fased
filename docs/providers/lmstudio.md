---
summary: "Run Fased with a local LM Studio server"
read_when:
  - You want LM Studio models in Agent > Models
  - You need localhost:1234 setup guidance
title: "LM Studio"
---

# LM Studio

LM Studio is a first-class **Agent > Models** provider for local open-weight
models. Fased talks to LM Studio through its OpenAI-compatible chat endpoint and
discovers models from the LM Studio local model API.

Fased does not install LM Studio and does not download its model weights. Run
LM Studio separately, then connect its local API from **Agent > Models**.

Default endpoints:

- Chat API: `http://127.0.0.1:1234/v1`
- Model discovery: `http://127.0.0.1:1234/api/v1/models`

## Quick start

1. Install LM Studio and start the local server.
2. Load or download a model in LM Studio.
3. Open **Agents > selected Agent > Models > LM Studio**.
4. Enter `http://127.0.0.1:1234/v1`, the model key, and optional API token.
5. Assign the model to the Agent's primary/fallback/task roles.

If LM Studio auth is disabled, leave the token blank. Fased stores a local
non-secret marker so the provider can be registered.

## Finding the model key

Ask LM Studio for its model list:

```bash
curl http://127.0.0.1:1234/api/v1/models
```

Use the returned `key` or `id` as the model ID. Fased model refs look like:

```text
lmstudio/qwen/qwen3.5-9b
```

## Config shape

```json5
{
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        api: "openai-completions",
        apiKey: "lmstudio-local",
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: "qwen/qwen3.5-9b",
            name: "qwen/qwen3.5-9b",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Security

LM Studio is treated as a private-network provider by default. Keep it on
localhost or a trusted tailnet/LAN host. If you enable LM Studio API
authentication, save the token in **Agent > Models** or expose it through
`LM_API_TOKEN`.
