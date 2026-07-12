---
summary: "Run Fased through LiteLLM Proxy for unified model access and usage tracking"
read_when:
  - You want to route Fased through a LiteLLM proxy
  - You need usage tracking, logging, or model routing through LiteLLM
---

# LiteLLM

[LiteLLM](https://litellm.ai) is an open-source LLM gateway that provides a
unified OpenAI-compatible API to many model providers.

Route Fased through LiteLLM when you want usage tracking, logging, virtual
keys, and backend switching behind one proxy.

## Why use LiteLLM with Fased?

- **Usage tracking** — Review Fased traffic across the models your proxy exposes
- **Model routing** — Switch between Claude, GPT, Gemini, Bedrock, local models, and other upstreams behind one proxy
- **Virtual keys** — Create keys with spend limits and model access limits for Fased
- **Logging** — Full request/response logs for debugging
- **Fallbacks** — Automatic failover if your primary provider is down

## Quick start

For normal browser setup, open **Agents**, select the Agent, then use **Agent >
Models > LiteLLM** to add the proxy URL/key and choose the Agent's model roles.
Use the CLI examples below when provisioning repeatable local or hosted proxies.

### Via onboarding

```bash
fased onboard --auth-choice litellm-api-key
```

### Manual setup

1. Start LiteLLM Proxy:

```bash
pip install 'litellm[proxy]'
litellm --model gpt-5.5
```

2. Point Fased to LiteLLM:

```bash
export LITELLM_API_KEY="your-litellm-key"

fased
```

That's it. Fased now routes through LiteLLM.

LiteLLM is a proxy, so the available model IDs are whatever your proxy exposes.
Fased discovers those IDs from the configured proxy and does not invent a
`litellm/default` model. Connect the proxy, then choose one of its returned
models in **Agent > Models**.

## Configuration

### Environment variables

```bash
export LITELLM_API_KEY="sk-litellm-key"
```

### Config file

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1000000,
            maxTokens: 128000,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/gpt-5.5" },
    },
  },
}
```

## Virtual keys

Create a dedicated key for Fased with spend limits:

```bash
curl -X POST "http://localhost:4000/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "fased",
    "max_budget": 50.00,
    "budget_duration": "monthly"
  }'
```

Use the generated key as `LITELLM_API_KEY`.

## Model routing

LiteLLM can route model requests to different backends. Configure in your LiteLLM `config.yaml`:

```yaml
model_list:
  - model_name: default
    litellm_params:
      model: openai/gpt-5.5
      api_key: os.environ/OPENAI_API_KEY

  - model_name: gpt-5.5
    litellm_params:
      model: openai/gpt-5.5
      api_key: os.environ/OPENAI_API_KEY
```

Fased requests the model ID you choose, such as `default` or `gpt-5.5`.
LiteLLM handles the upstream routing.

## Model discovery

LiteLLM exposes the models available on your proxy through `/models` when
configured for model discovery. That model list is local to your LiteLLM
instance, not a global LiteLLM catalog.

```bash
curl "http://localhost:4000/models" \
  -H "Authorization: Bearer $LITELLM_API_KEY"
```

Because this catalog is instance-local, `fased providers refresh` does not fetch
a central LiteLLM model list. In the normal UI, LiteLLM is treated as a dynamic
provider: `litellm/<model-id>` is allowed when your proxy exposes that model.

## Viewing usage

Fased **Usage** shows the local model usage history for calls made by Fased,
grouped by provider, model, Agent, task, channel, and session. LiteLLM's
dashboard or API shows proxy-level spend and quota from LiteLLM's perspective:

```bash
# Key info
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-litellm-key"

# Spend logs
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## Notes

- LiteLLM runs on `http://localhost:4000` by default
- Fased connects via the OpenAI-compatible chat completions endpoint
- Capabilities depend on the upstream model and how your LiteLLM proxy exposes it

## See also

- [LiteLLM Docs](https://docs.litellm.ai)
- [Model Providers](/concepts/model-providers)
