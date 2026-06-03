---
summary: "Use OpenCode Zen (curated models) with Fased"
read_when:
  - You want OpenCode Zen for model access
  - You want a curated list of coding-friendly models
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen is a **curated list of models** recommended by the OpenCode team for coding agents.
It is an optional, hosted model access path that uses an API key and the `opencode` provider.
Zen is currently in beta.

OpenCode Zen is a current Fased model provider route. The auth choice is
`opencode-zen`; the model route is `opencode`.

## Browser setup

Open **Agents**, select the Agent, then use **Agent > Models > OpenCode Zen** to
add the API key and choose a primary, fallback, or task model.

## CLI setup

```bash
fased onboard --auth-choice opencode-zen
# or non-interactive
fased onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/gpt-5.5" } } },
}
```

## Notes

- `OPENCODE_ZEN_API_KEY` is also supported.
- You sign in to Zen, add billing details, copy your API key, and select a model like `opencode/gpt-5.5`.
- Usage and billing follow your OpenCode Zen account; check the provider dashboard for details.
