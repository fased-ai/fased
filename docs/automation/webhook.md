---
summary: "Webhook ingress for gateway wakeups and isolated agent runs"
read_when:
  - Wiring external systems into Fased
  - Adding or changing inbound webhook behavior
title: "Webhooks"
---

# Webhooks

Fased can expose a small authenticated HTTP endpoint for trusted automation.
Use it when another system needs to wake the main session, run an isolated
Agent turn, or map external payloads into Fased work.

Treat webhooks as private ingress. Keep them behind loopback, Tailscale, or a
trusted reverse proxy.

This page is about inbound HTTP. For local runtime extensions that run inside
the gateway, use [Hooks](/automation/hooks).

The normal UI is **Agent > Tasks > Webhook Triggers**. That is where operators
create authenticated trigger paths next to scheduled tasks while keeping the
same token, route, and Agent policy boundaries.

## Enable webhook ingress

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    allowedAgentIds: ["hooks", "main"],
  },
}
```

Notes:

- `hooks.token` is required when `hooks.enabled = true`
- `hooks.path` defaults to `/hooks`
- `hooks.allowedAgentIds` controls explicit `agentId` routing
  - omit it or include `"*"` to allow any agent id
  - set `[]` to block all explicit `agentId` routing
  - unknown explicit ids resolve to the default Agent before the allowlist check

## Auth

Every request must send the hook token.

Accepted forms:

- `Authorization: Bearer <token>` (preferred)
- `x-fased-token: <token>`

Rejected:

- query-string tokens such as `?token=...`

## Endpoint: `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

Fields:

- `text` required
- `mode` optional: `now` or `next-heartbeat`

Effect:

- queues a system event for the main session
- if `mode = "now"`, triggers an immediate heartbeat

## Endpoint: `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "agentId": "hooks",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.4-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

Fields:

- `message` required
- `name` optional label used in summaries
- `agentId` optional; unknown ids resolve to the default Agent
- `sessionKey` optional; rejected by default unless
  `hooks.allowRequestSessionKey = true`
- `wakeMode` optional: `now` or `next-heartbeat`
- `deliver` optional, defaults to `true`
- `channel` optional, defaults to `last`
- `to` optional recipient for the chosen channel
- `model`, `thinking`, `timeoutSeconds` optional run overrides

Effect:

- starts an isolated agent turn
- posts a summary into the main session
- optionally delivers the run output to a chat target

## Session-key policy

Caller-selected session keys are off by default.

Recommended config:

```json5
{
  hooks: {
    enabled: true,
    token: "${FASED_HOOKS_TOKEN}",
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
  },
}
```

Legacy-compatible config:

```json5
{
  hooks: {
    enabled: true,
    token: "${FASED_HOOKS_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:"],
  },
}
```

If you enable request-provided `sessionKey`, lock it down with prefixes.

## Mapped endpoints: `POST /hooks/<name>`

Named paths are resolved through `hooks.mappings`. Use **Agent > Tasks >
Webhook Triggers** for the common case. It creates a mapping, enables
`hooks.enabled`, generates a hook token on first save when needed, and shows the
endpoint URL. Manual config is still available for advanced operators.

## Agent Trigger modal

The **+ Trigger** button in **Agent > Tasks** creates a saved Trigger definition,
which sits beside scheduled Tasks in the same page. The selected Agent owns the
definition. Every matching POST creates a run-history row with
`definitionKind = "trigger"`. If the target is a workflow or graph, the
workflow run is linked by the same correlation id.

**Name**

Human label shown under the Agent's Trigger definitions.

**Path**

Endpoint path under the configured hooks base path, for example
`/hooks/release`.

**Run target**

`Agent prompt`, `Workflow / graph`, or `Heartbeat wake`.

**Run timing**

`Run now` starts immediately. `Next heartbeat` queues work for the Agent
heartbeat loop.

**Workflow target**

Saved workflow or graph to run when the Trigger fires.

**Delivery**

`Internal only` records history. `Deliver reply` also sends the Agent reply.

**Prompt template**

Template for Agent prompt or wake text. Supports `{{payload}}`, `{{headers}}`,
`{{path}}`, and `{{now}}`.

**Reply channel/target**

Optional delivery route used when delivery is enabled.

**Timeout**

Optional Agent turn timeout in seconds.

**Notify**

Run-history notification policy: silent, done only, or state changes.

Use a Trigger when an outside system calls Fased over HTTP. Use a Task when
Fased should run something on its own schedule.

Mapped triggers let you accept arbitrary external payloads and transform them
into:

- `wake` actions
- isolated `agent` actions
- saved `workflow` or graph actions

Main options:

- `hooks.presets: ["gmail"]` enables the built-in Gmail mapping
- `hooks.mappings` defines `match`, `action`, templates, delivery, and routing
- `hooks.transformsDir` plus `transform.module` loads custom JS/TS transforms
- `agentId` lets a mapping route to a specific agent
- `hooks.defaultSessionKey` provides the fallback session key
- `{{payload}}` or `{{body}}` inserts the full JSON payload in templates
- `{{headers}}` inserts request headers for diagnostics
- `allowUnsafeExternalContent: true` disables the external-content safety
  wrapper for that mapping

Transform boundaries:

- `hooks.transformsDir` must stay under your Fased config tree, typically
  `~/.fased/hooks/transforms`
- `transform.module` must resolve inside the effective transforms directory
- path escape / traversal attempts are rejected

Gmail helpers:

- `fased webhooks gmail setup` writes `hooks.gmail` config for
  `fased webhooks gmail run`
- the full flow is documented in [Gmail Pub/Sub](/automation/gmail-pubsub)

## Response codes

- `200` for wake actions
- `202` for agent or workflow actions
- `204` when a mapping transform intentionally skips the payload
- `400` for invalid payloads
- `401` for auth failure
- `404` when no mapped endpoint matches the path
- `405` for non-POST requests
- `408` when the request body times out
- `413` for oversized payloads
- `429` after repeated auth failures from the same client
- `500` when a mapping transform fails unexpectedly

## Examples

Wake the main session:

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

Run an isolated agent turn:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-fased-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

Override the model for one run:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-fased-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.4-mini"}'
```

Use a model that is already configured for the target Agent. For the simplest
setup, omit `model` and let the Agent use its primary/fallback model settings.

Mapped Gmail payload:

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Security

- keep webhook ingress on loopback, a tailnet, or behind a trusted reverse
  proxy
- use a dedicated hook token separate from your main gateway auth token
- repeated auth failures are rate-limited per client address
- if you expose multi-agent routing, set `hooks.allowedAgentIds`
- keep `hooks.allowRequestSessionKey = false` for the normal setup
- restrict request session keys with `hooks.allowedSessionKeyPrefixes` when
  request-provided session keys are enabled
- avoid dumping raw third-party payloads into logs
- external content is treated as untrusted by default; only set
  `allowUnsafeExternalContent: true` for tightly controlled internal feeds
