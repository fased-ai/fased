---
summary: "Use Synthetic's Anthropic-compatible API in Fased"
read_when:
  - You want to use Synthetic as a model provider
  - You need a Synthetic API key or base URL setup
title: "Synthetic"
---

# Synthetic

Synthetic exposes Anthropic-compatible endpoints. Fased registers it as the
`synthetic` provider and uses the Anthropic Messages API. Synthetic also offers
OpenAI-compatible endpoints, but this Fased provider route intentionally uses
the Anthropic-compatible endpoint.

## Quick setup

1. Set `SYNTHETIC_API_KEY` (or run the wizard below).
2. Run onboarding:

```bash
fased onboard --auth-choice synthetic-api-key
```

The default model is set to:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.5
```

## Config example

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.5": { alias: "MiniMax M2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.5",
            name: "MiniMax M2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 191488,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Note: Fased's Anthropic client appends `/v1` to the base URL, so use
`https://api.synthetic.new/anthropic` (not `/anthropic/v1`). If Synthetic changes
its base URL, override `models.providers.synthetic.baseUrl`.

## Model catalog

All models below use cost `0` (input/output/cache).

**65k max tokens**

- `hf:zai-org/GLM-5.1` — context `196608`, reasoning, text
- `hf:moonshotai/Kimi-K2.6` — context `262144`, reasoning, text + image
- `hf:MiniMaxAI/MiniMax-M2.5` — context `191488`, text
- `hf:zai-org/GLM-4.7-Flash` — context `196608`, text
- `hf:zai-org/GLM-5` — context `196608`, reasoning, text
- `hf:zai-org/GLM-4.7` — context `202752`, text

**8k max tokens**

- `hf:deepseek-ai/DeepSeek-V3.2` — context `159000`, text
- `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct` — context `256000`, text
- `hf:Qwen/Qwen3-235B-A22B-Thinking-2507` — context `256000`, reasoning, text
- `hf:Qwen/Qwen3.5-397B-A17B` — context `256000`, text
- `hf:nvidia/Kimi-K2.5-NVFP4` — context `256000`, text
- `hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` — context `256000`, text
- `hf:openai/gpt-oss-120b` — context `128000`, text
- `hf:meta-llama/Llama-3.3-70B-Instruct` — context `128000`, text
- `hf:deepseek-ai/DeepSeek-R1-0528` — context `128000`, reasoning, text
- `hf:moonshotai/Kimi-K2.5` — context `262144`, reasoning, text + image
- `hf:deepseek-ai/DeepSeek-V3` — context `128000`, text

## Notes

- Model refs use `synthetic/<modelId>`.
- If you enable a model allowlist (`agents.defaults.models`), add every model you
  plan to use.
- See [Model providers](/concepts/model-providers) for provider rules.
