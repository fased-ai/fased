---
summary: "Run Fased with vLLM-compatible local servers"
read_when:
  - You want to run Fased against a local vLLM-compatible server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: "vLLM-compatible"
---

# vLLM-Compatible

vLLM can serve open-source (and some custom) models via an
**OpenAI-compatible** HTTP API. Fased connects through the
`vllm` / `openai-completions` route.

Use this same provider for vLLM, SGLang, TGI, LocalAI, FastChat, and similar
OpenAI-compatible local servers. Use **Custom Provider** only when this shortcut
does not match your endpoint.

Fased can also **auto-discover** available models when you opt in with
`VLLM_API_KEY` (any value works if your server does not enforce auth) and you do
not define an explicit `models.providers.vllm` entry.

## Quick start

1. Start the OpenAI-compatible server.

Your base URL should expose `/v1` endpoints such as `/v1/models` and
`/v1/chat/completions`. Local servers commonly run on:

- `http://127.0.0.1:8000/v1`

2. Opt in (any value works if no auth is configured):

```bash
export VLLM_API_KEY="vllm-local"
```

3. Select a model (replace with one of your served model IDs):

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/your-model-id" },
    },
  },
}
```

## Model discovery (implicit provider)

When `VLLM_API_KEY` is set (or an auth profile exists) and you **do not** define
`models.providers.vllm`, Fased will query:

- `GET http://127.0.0.1:8000/v1/models`

…and convert the returned IDs into model entries.

If you set `models.providers.vllm` explicitly, auto-discovery is skipped and you
must define models manually.

## Explicit configuration (manual models)

Use explicit config when:

- the server runs on a different host/port.
- You want to pin `contextWindow`/`maxTokens` values.
- Your server requires a real API key (or you want to control headers).

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: "your-model-id",
            name: "Local Served Model",
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

`request.allowPrivateNetwork: true` is required for loopback, LAN, and private
VPS endpoints. Public model providers should leave it unset.

## Health And Capabilities

Agent > Models probes this provider when configured. The row can show reachable,
auth ok, models discovered, and private network approved. Fased does not assume
vision, tools, or reasoning support from a local model ID unless the configured
model entry declares it.

## Troubleshooting

- Check the server is reachable:

```bash
curl http://127.0.0.1:8000/v1/models
```

- If requests fail with auth errors, set a real `VLLM_API_KEY` that matches your
  server configuration, or configure the provider explicitly under
  `models.providers.vllm`.
