---
summary: "Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the Gateway"
read_when:
  - Integrating tools that expect OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

Fased’s Gateway can serve a small OpenAI-compatible Chat Completions endpoint.

This endpoint is **disabled by default**. When disabled, the route is not served.

- `POST /v1/chat/completions`
- Same port as the Gateway:
  `http://<gateway-host>:<port>/v1/chat/completions`

Under the hood, requests execute as a normal Gateway agent run. Routing,
permissions, and config match your Gateway.

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

Notes:

- When `gateway.auth.mode="token"`, use `gateway.auth.token` or
  `FASED_GATEWAY_TOKEN`.
- When `gateway.auth.mode="password"`, use `gateway.auth.password` or
  `FASED_GATEWAY_PASSWORD`.
- If `gateway.auth.rateLimit` is configured and too many auth failures occur,
  the endpoint returns `429` with `Retry-After`.

## Choosing an agent

No custom headers required: encode the agent id in the OpenAI `model` field:

- `model: "fased:<agentId>"` (example: `"fased:main"`, `"fased:beta"`)
- `model: "fased/<agentId>"` (alias)
- `model: "agent:<agentId>"` (alias)

Or target a specific Fased agent by header:

- `x-fased-agent-id: <agentId>` (default: `main`)
- `x-fased-agent: <agentId>` (alias)

Advanced:

- `x-fased-session-key: <sessionKey>` to fully control session routing.

## Enabling the endpoint

Set `gateway.http.endpoints.chatCompletions.enabled` to `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Disabling the endpoint

Set `gateway.http.endpoints.chatCompletions.enabled` to `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Session behavior

By default, the endpoint is **stateless per request**. A new session key is
generated for each call.

If the request includes an OpenAI `user` string, the Gateway derives a stable
session key from it so repeated calls can share an agent session.

## Message support

- `system` and `developer` messages become extra system instructions for the run.
- `user`, `assistant`, `tool`, and `function` messages become conversation context.
- Text content is supported. Non-text message parts are ignored by this compatibility endpoint.
- Request bodies are capped at 1 MiB.
- Usage fields are returned in the OpenAI shape, but token counts are currently `0`.

## Streaming (SSE)

Set `stream: true` to receive Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Each event line is `data: <json>`
- Stream ends with `data: [DONE]`

## Examples

Non-streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-fased-agent-id: main' \
  -d '{
    "model": "fased",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-fased-agent-id: main' \
  -d '{
    "model": "fased",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
