---
summary: "Use OpenAI via API keys or ChatGPT sign-in in Fased"
read_when:
  - You want to use OpenAI models in Fased
  - You want ChatGPT sign-in instead of API keys
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. Fased exposes one OpenAI brand
with two auth methods: **OpenAI API key** for Platform API access and **OpenAI
sign-in** for ChatGPT account access. Internal transport route names are not
separate providers and are not shown in normal model pickers.

## Where to set it up

Use the same two OpenAI methods in every setup surface:

- **Control UI:** Open **Agents**, select an Agent, then use **Agent > Models**.
  Choose **OpenAI**, then **Sign in** or **API key**, and assign the Agent's
  model roles there. Chat can override the model for the current session.
- **Onboarding:** Choose **Set up model providers** only if you want provider
  setup during onboarding. Choose **OpenAI (OpenAI sign-in + API key)**, then
  pick **OpenAI sign-in** or **OpenAI API key**.
- **CLI:** Use `fased onboard --auth-choice openai-codex` for sign-in,
  `fased onboard --auth-choice openai-api-key`, or
  `fased onboard --openai-api-key "$OPENAI_API_KEY"` for API key setup.

The two auth methods have independent credentials and model availability:

- **Sign in** uses the Fased-managed, version-matched OpenAI sign-in runtime.
- **API key** uses the direct OpenAI API route and account model discovery.

Pick the credential method first, then choose from the models that credential
can actually access. Fased keeps the exact route in the saved model record so
Chat and Tasks execute with the same credential and transport selected in
**Agent > Models**.

The picker has three distinct concepts:

- **Available:** models reported for the authenticated account or endpoint.
- **Recommended:** Fased's ranked subset of those available models.
- **Assigned:** models saved for this Agent's primary, fallback, cheap, strong,
  escalation, coding, and summarizer roles.

## Option A: OpenAI API key (OpenAI Platform)

**Best for:** direct API access and usage-based billing.
Get your API key from the OpenAI dashboard.

### API key control UI setup

1. Open **Agents** and select the Agent.
2. Open **Agent > Models**.
3. Open **OpenAI**.
4. Use **API key** and paste an OpenAI Platform key.
5. Choose the Agent's OpenAI model roles.

The credential is stored in the agent auth profile store as `openai:default`.

### API key onboarding setup

```bash
fased onboard
# choose: Set up model providers -> OpenAI -> OpenAI API key
```

### API key CLI setup

```bash
fased onboard --auth-choice openai-api-key
# or non-interactive
fased onboard --openai-api-key "$OPENAI_API_KEY"
```

### API key config snippet

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.6" } } },
}
```

## Option B: OpenAI sign-in (ChatGPT)

**Best for:** using ChatGPT OAuth access instead of an API key.

### Sign-in control UI setup

1. Open **Agents** and select the Agent.
2. Open **Agent > Models**.
3. Open **OpenAI**.
4. Choose **Sign in**.
5. Open or copy the sign-in URL shown in the modal.
6. Finish OpenAI login in the browser.
7. Return to **Agent > Models** after the modal reports success, then choose a
   model role for the Agent or use Chat to override a single session.

Fased installs and verifies its matching sign-in runtime during authentication.
Normal `fased update` updates core, Gateway, dashboard assets, and the managed
runtime together. If a matching runtime is missing, authenticated discovery or
execution repairs it before listing or running a sign-in model.

### Sign-in onboarding setup

```bash
fased onboard
# choose: Set up model providers -> OpenAI -> OpenAI sign-in
```

### Sign-in CLI setup

```bash
# Run OpenAI sign-in in the wizard
fased onboard --auth-choice openai-codex

# Or run OAuth directly
fased models auth login --provider openai-codex
```

### Sign-in model selection

```bash
fased models list --all --provider openai-codex
```

The sign-in catalog comes from the authenticated, Fased-owned runtime. Only
select a model returned by that command. Fased's reviewed catalog adds
capability metadata and recommendation order, but it does not turn an
unavailable model into an available one. An OpenAI API key does not unlock the
ChatGPT route, and ChatGPT sign-in does not unlock direct API billing.

### Sign-in transport default

For `openai-codex/*` sign-in models, Fased uses its managed OpenAI sign-in
transport. You can set
`agents.defaults.models.<provider/model>.params.transport` when you need to
force the streaming path:

- Default is `"auto"` (WebSocket-first, then SSE fallback).
- `"sse"`: force SSE
- `"websocket"`: force WebSocket
- `"auto"`: try WebSocket, then fall back to SSE

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.5" },
      models: {
        "openai-codex/gpt-5.5": {
          params: {
            transport: "auto",
          },
        },
      },
    },
  },
}
```

### OpenAI Responses server-side compaction

For direct OpenAI Responses models (`openai/*` using `api: "openai-responses"` with
`baseUrl` on `api.openai.com`), Fased now auto-enables OpenAI server-side
compaction payload hints:

- Forces `store: true` (unless model compat sets `supportsStore: false`)
- Injects `context_management: [{ type: "compaction", compact_threshold: ... }]`

By default, `compact_threshold` is `70%` of model `contextWindow` (or `80000`
when unavailable).

### Enable server-side compaction explicitly

Use this when you want to force `context_management` injection on compatible
Responses models (for example Azure OpenAI Responses):

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/your-model-id": {
          params: {
            responsesServerCompaction: true,
          },
        },
      },
    },
  },
}
```

### Enable with a custom threshold

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.6": {
          params: {
            responsesServerCompaction: true,
            responsesCompactThreshold: 120000,
          },
        },
      },
    },
  },
}
```

### Disable server-side compaction

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.6": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction` only controls `context_management` injection.
Direct OpenAI Responses models still force `store: true` unless compat sets
`supportsStore: false`.

## Notes

- Model refs always use `provider/model` (see [/concepts/models](/concepts/models)).
- Model availability can differ between ChatGPT sign-in and an OpenAI API key.
  The UI groups both under OpenAI while preserving the exact credential route
  internally.
- The Gateway owns the authenticated model catalog. **Agent > Models** and
  Chat and Tasks consume that same canonical catalog and persisted assignment
  records; they do not maintain separate entitlement lists.
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).
- **Agent > Models** owns OpenAI credentials and that Agent's model roles. Chat
  can choose a session-level model from the authenticated provider catalog.
