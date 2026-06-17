---
title: "Cloudflare AI Gateway"
summary: "Cloudflare AI Gateway setup (auth + model selection)"
read_when:
  - You want to use Cloudflare AI Gateway with Fased
  - You need the account ID, gateway ID, or API key env var
---

# Cloudflare AI Gateway

Cloudflare AI Gateway sits in front of provider APIs and lets you add
analytics, caching, rate limits, and controls. Fased's current built-in setup
uses the Anthropic Messages API through your Gateway endpoint.

Cloudflare AI Gateway is a current Fased model provider route. The built-in
route is intentionally narrow: it configures Cloudflare Gateway as an Anthropic
Messages path, then exposes it in **Agent > Models**.

- Provider: `cloudflare-ai-gateway`
- Base URL: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- Default model: `cloudflare-ai-gateway/claude-sonnet-4-6`
- API key: `CLOUDFLARE_AI_GATEWAY_API_KEY`
  (the Anthropic provider key used for requests through this Gateway path)
- Auth method: Account ID + Gateway ID + API key

Cloudflare also supports OpenAI-compatible Gateway routes, Workers AI routes,
and authenticated Gateway tokens. Those are not the default Fased Cloudflare
setup yet. Use the explicit `models.providers.cloudflare-ai-gateway` config if
you intentionally need a different Cloudflare Gateway path.

## Quick start

1. Set the provider API key and Gateway details. In the browser, use **Agents >
   selected Agent > Models > Cloudflare AI Gateway**. For CLI setup:

```bash
fased onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. Open **Agents**, select the Agent, then use **Agent > Models** to choose the
   Cloudflare AI Gateway model for primary, fallback, or task work.

For scripted setup, you can set the Agent default model in config:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-6" },
    },
  },
}
```

## Non-interactive example

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## Authenticated gateways

If you enabled Gateway authentication in Cloudflare, add the
`cf-aig-authorization` header. This is in addition to the provider API key used
by the upstream model provider.

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## Model scope

The normal Fased picker shows the supported built-in Cloudflare model:

- `cloudflare-ai-gateway/claude-sonnet-4-6`

Cloudflare Gateway can route to many upstream providers, but Fased does not
pretend there is one global Cloudflare model catalog. If you configure a custom
Cloudflare Gateway route, add the exact model entries in **Advanced > Config**
so **Agent > Models** and Chat know which model IDs are valid for your Gateway.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure
`CLOUDFLARE_AI_GATEWAY_API_KEY` is available to that process. Use
`~/.fased/.env` or `env.shellEnv`.
