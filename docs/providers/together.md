---
summary: "Together AI setup (auth + model selection)"
read_when:
  - You want to use Together AI with Fased
  - You need the API key env var or CLI auth choice
---

# Together AI

The [Together AI](https://together.ai) provides access to leading open-source models including Llama, DeepSeek, Kimi, and more through a unified API.

- Provider: `together`
- Auth: `TOGETHER_API_KEY`
- API: OpenAI-compatible
- Base URL: `https://api.together.xyz/v1`

## Quick start

1. Set the API key (recommended: store it for the Gateway):

```bash
fased onboard --auth-choice together-api-key
```

2. Open **Agents**, select the Agent, then use **Agent > Models** to choose a
   Together model for primary, fallback, or task work.

For scripted setup, you can set the Agent default model in config:

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.6" },
    },
  },
}
```

## Non-interactive example

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

This stores the key and can set `together/moonshotai/Kimi-K2.6` as the Agent
default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `TOGETHER_API_KEY`
is available to that process (for example, in `~/.fased/.env` or via
`env.shellEnv`).

## Available models

Together AI provides access to many popular open-source models:

- **Kimi K2.6** - default high-quality Kimi chat, reasoning, and vision model.
- **Kimi K2.5** - earlier Kimi fallback route.
- **MiniMax M2.7** - efficient chat model with function calling and structured outputs.
- **GLM-5.1 / GLM-5** - coding, function calling, and structured-output models.
- **Qwen3.6 Plus / Qwen3.5** - long-context Qwen chat and vision models.
- **GPT-OSS 120B / 20B** - open-weight reasoning models.
- **DeepSeek V4 Pro** - large-context reasoning model.
- **Qwen3 Coder** - coding-focused model.
- **Llama 3.3 70B Instruct Turbo** - fast instruction-following model.
- **Gemma 4 31B IT** - small/fast vision-capable model.

All models here support standard chat completions and are OpenAI API compatible.
Image, video, audio, embedding, rerank, and moderation models live in separate
Together endpoints and are not exposed through this chat-provider route.
