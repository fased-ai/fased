---
summary: "Hugging Face Inference setup (auth + model selection)"
read_when:
  - You want to use Hugging Face Inference with Fased
  - You need the HF token env var or CLI auth choice
title: "Hugging Face (Inference)"
---

# Hugging Face (Inference)

[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) offer OpenAI-compatible chat completions through a single router API. You get access to many models (DeepSeek, Llama, and more) with one token. Fased uses the **OpenAI-compatible endpoint** (chat completions only); for text-to-image, embeddings, or speech use the [HF inference clients](https://huggingface.co/docs/api-inference/quicktour) directly.

Hugging Face is a current Fased model provider route. The route id is
`huggingface`; model availability comes from the HF router plus Fased's built-in
catalog fallback.

- Provider: `huggingface`
- Auth: `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN` (fine-grained token with **Make calls to Inference Providers**)
- API: OpenAI-compatible (`https://router.huggingface.co/v1`)
- Billing: Single HF token; [pricing](https://huggingface.co/docs/inference-providers/pricing) follows the active provider route.

## Quick start

1. Create a fine-grained token at [Hugging Face → Settings → Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) with the **Make calls to Inference Providers** permission.
2. Run onboarding and choose **Hugging Face** in the provider dropdown, then enter your API key when prompted:

```bash
fased onboard --auth-choice huggingface-api-key
```

3. In onboarding, pick the Hugging Face model you want. The list is loaded from
   the Inference API when you have a valid token; otherwise a built-in list is
   shown.
4. In the browser UI, open **Agents**, select the Agent, then use **Agent >
   Models** to assign Hugging Face as the Agent's primary, fallback, or task
   model.
5. You can also set the Agent default model in config for automation:

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/openai/gpt-oss-120b" },
    },
  },
}
```

## Non-interactive example

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

This stores the key and can set `huggingface/openai/gpt-oss-120b` as the Agent
default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`
is available to that process (for example, in `~/.fased/.env` or via
`env.shellEnv`).

## Model discovery and onboarding dropdown

Fased discovers models by calling the **Inference endpoint directly**:

```bash
GET https://router.huggingface.co/v1/models
```

(Optional: send `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` or `$HF_TOKEN` for the full list; some endpoints return a subset without auth.) The response is OpenAI-style `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`.

When you configure a Hugging Face API key (via onboarding, `HUGGINGFACE_HUB_TOKEN`, or `HF_TOKEN`), Fased uses this GET to discover available chat-completion models. During **interactive onboarding**, after you enter your token you see a **Default Hugging Face model** dropdown populated from that list (or the built-in catalog if the request fails). At runtime (e.g. Gateway startup), when a key is present, Fased again calls **GET** `https://router.huggingface.co/v1/models` to refresh the catalog. The list is merged with a built-in catalog (for metadata like context window and cost). If the request fails or no key is set, only the built-in catalog is used.

## Model names and editable options

- **Name from API:** The model display name is **hydrated from GET /v1/models** when the API returns `name`, `title`, or `display_name`; otherwise it is derived from the model id (e.g. `openai/gpt-oss-120b` → “GPT OSS 120B”).
- **Override display name:** You can set a custom label per model in config so it appears the way you want in the CLI and UI:

```json5
{
  agents: {
    defaults: {
      models: {
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
        "huggingface/openai/gpt-oss-120b:cheapest": { alias: "GPT-OSS 120B (cheap)" },
      },
    },
  },
}
```

- **Provider / policy selection:** Append a suffix to the **model id** to choose how the router picks the backend:
  - **`:fastest`** — highest throughput (router picks; provider choice is **locked** — no interactive backend picker).
  - **`:cheapest`** — lowest cost per output token (router picks; provider choice is **locked**).
  - **`:provider`** — force a specific backend (e.g. `:sambanova`, `:together`).

  When you select **:cheapest** or **:fastest** (e.g. in the onboarding model dropdown), the provider is locked: the router decides by cost or speed and no optional “prefer specific backend” step is shown. You can add these as separate entries in `models.providers.huggingface.models` or set `model.primary` with the suffix. You can also set your default order in [Inference Provider settings](https://hf.co/settings/inference-providers) (no suffix = use that order).

- **Config merge:** Existing entries in `models.providers.huggingface.models` (e.g. in `models.json`) are kept when config is merged. So any custom `name`, `alias`, or model options you set there are preserved.

## Model IDs and configuration examples

Model refs use the form `huggingface/<org>/<model>` (Hub-style IDs). The first-run list is curated from the official Chat Completion recommendations; when you have a valid token, the runtime can still discover more with **GET** `https://router.huggingface.co/v1/models`.

**Example IDs from Fased's built-in Hugging Face catalog:**

| Model             | Ref (prefix with `huggingface/`)      |
| ----------------- | ------------------------------------- |
| GPT-OSS 120B      | `openai/gpt-oss-120b`                 |
| DeepSeek V4 Pro   | `deepseek-ai/DeepSeek-V4-Pro`         |
| Kimi K2.6         | `moonshotai/Kimi-K2.6`                |
| MiniMax M2.7      | `MiniMaxAI/MiniMax-M2.7`              |
| GLM 5.1           | `zai-org/GLM-5.1`                     |
| Qwen3.6 35B A3B   | `Qwen/Qwen3.6-35B-A3B`                |
| Qwen3.5 397B A17B | `Qwen/Qwen3.5-397B-A17B`              |
| Qwen3 Coder Next  | `Qwen/Qwen3-Coder-Next`               |
| Qwen3 Coder 480B  | `Qwen/Qwen3-Coder-480B-A35B-Instruct` |
| Gemma 4 31B IT    | `google/gemma-4-31B-it`               |

You can append `:fastest`, `:cheapest`, or `:provider` (e.g. `:together`, `:sambanova`) to the model id. Set your default order in [Inference Provider settings](https://hf.co/settings/inference-providers); see [Inference Providers](https://huggingface.co/docs/inference-providers) and **GET** `https://router.huggingface.co/v1/models` for the full list.

### Complete configuration examples

**Primary GPT-OSS 120B with Qwen Coder fallback:**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/openai/gpt-oss-120b",
        fallbacks: ["huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct"],
      },
      models: {
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
        "huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct": { alias: "Qwen3 Coder" },
      },
    },
  },
}
```

**Qwen as default, with :cheapest and :fastest variants:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen3.6-35B-A3B" },
      models: {
        "huggingface/Qwen/Qwen3.6-35B-A3B": { alias: "Qwen3.6 35B" },
        "huggingface/Qwen/Qwen3.6-35B-A3B:cheapest": { alias: "Qwen3.6 35B (cheap)" },
        "huggingface/Qwen/Qwen3.6-35B-A3B:fastest": { alias: "Qwen3.6 35B (fast)" },
      },
    },
  },
}
```

**GPT-OSS + GLM + DeepSeek with aliases:**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/openai/gpt-oss-120b",
        fallbacks: ["huggingface/zai-org/GLM-5.1", "huggingface/deepseek-ai/DeepSeek-V4-Pro"],
      },
      models: {
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
        "huggingface/zai-org/GLM-5.1": { alias: "GLM 5.1" },
        "huggingface/deepseek-ai/DeepSeek-V4-Pro": { alias: "DeepSeek V4 Pro" },
      },
    },
  },
}
```

**Force a specific backend with :provider:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1:together" },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1:together": { alias: "DeepSeek R1 (Together)" },
      },
    },
  },
}
```

**Multiple Qwen and DeepSeek models with policy suffixes:**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen3.6-35B-A3B:cheapest" },
      models: {
        "huggingface/Qwen/Qwen3.6-35B-A3B": { alias: "Qwen3.6 35B" },
        "huggingface/Qwen/Qwen3.6-35B-A3B:cheapest": { alias: "Qwen3.6 35B (cheap)" },
        "huggingface/deepseek-ai/DeepSeek-R1:fastest": { alias: "DeepSeek R1 (fast)" },
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
      },
    },
  },
}
```
