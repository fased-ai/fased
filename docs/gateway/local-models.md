---
summary: "Run Fased on local LLMs (Ollama, LM Studio, vLLM, LiteLLM, custom endpoints)"
read_when:
  - You want to serve models from your own GPU box
  - You are wiring Ollama, LM Studio, or an OpenAI-compatible proxy
  - You need conservative local model guidance
title: "Local Models"
---

# Local models

Local is doable, but Fased works best with enough context and model quality for tool-heavy, security-sensitive conversations. Small or heavily quantized models can truncate context, miss policy cues, or produce weaker tool decisions. Use the strongest model your hardware can run reliably, keep hosted fallback models configured when you need higher reliability, and review local-model exposure with the same care as any private endpoint (see [Security](/gateway/security)).

## Advanced local stack: LM Studio

Load a strong model in LM Studio, enable the local server, and connect Fased
through the first-class **LM Studio** provider in **Agent > Models**.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/qwen/qwen3.5-9b" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/qwen/qwen3.5-9b": { alias: "LM Studio" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio-local",
        api: "openai-completions",
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

**Setup checklist**

- Install LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- In LM Studio, download the largest model you can run reliably, start the server,
  and confirm `http://127.0.0.1:1234/api/v1/models` lists it.
- Keep the model loaded; cold-load adds startup latency.
- Adjust `contextWindow`/`maxTokens` if your LM Studio build differs.
- If LM Studio auth is disabled, leave the token blank in **Agent > Models**.

Keep hosted models configured even when running local; use `models.mode: "merge"` so fallbacks stay available.

### Hybrid config: hosted primary, local fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/qwen/qwen3.5-9b", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/qwen/qwen3.5-9b": { alias: "LM Studio" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio-local",
        api: "openai-completions",
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

### Local-first with hosted safety net

Swap the primary and fallback order; keep the same providers block and `models.mode: "merge"` so you can fall back to Sonnet or Opus when the local box is down.

### Regional hosting / data routing

- Hosted MiniMax/Kimi/GLM variants also exist on OpenRouter with region-pinned endpoints (e.g., US-hosted). Pick the regional variant there to keep traffic in your chosen jurisdiction while still using `models.mode: "merge"` for Anthropic/OpenAI fallbacks.
- Local-only remains the strongest privacy path; hosted regional routing is the middle ground when you need provider features but want control over data flow.

## Registry-Supported Local Routes

Normal setup should use **Agent > Models** in the Control UI. Add or select one
of these provider surfaces there:

- Ollama for a native local/cloud/hybrid Ollama server.
- LM Studio for the local server on `localhost:1234`.
- vLLM for a vLLM server.
- LiteLLM for a LiteLLM gateway.
- Custom Provider for SGLang or any other private OpenAI-compatible endpoint.

### Ollama

For the normal UI path:

```text
Provider: Ollama
Base URL: http://127.0.0.1:11434
API key: optional for local-only
Model: llama3.3
```

Ollama uses the native API. Do not configure it as `/v1` unless you deliberately
choose **Custom Provider** for compatibility testing.

## Other OpenAI-compatible Local Proxies

vLLM, LiteLLM, SGLang, OAI-proxy, or custom gateways work if they expose an
OpenAI-style `/v1` endpoint. Replace the provider block above with your endpoint
and model ID:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Keep `models.mode: "merge"` so hosted models stay available as fallbacks.

Private, loopback, and LAN model provider URLs require `request.allowPrivateNetwork: true`.
Public hosted providers do not need this flag.

## Troubleshooting

- Gateway can reach the proxy? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio model unloaded? Reload; cold start is a common “hanging” cause.
- Context errors? Lower `contextWindow` or raise your server limit.
- Safety: local models skip provider-side filters; keep agents narrow and compaction on to limit prompt injection blast radius.
