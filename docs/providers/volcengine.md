---
summary: "Volcano Engine ARK setup"
title: "Volcano Engine"
read_when:
  - You want to use Volcano Engine ARK models
  - You need provider ids or API key env vars
---

# Volcano Engine

Fased supports Volcano Engine ARK model endpoints, including coding aliases used
by onboarding. Volcano Engine uses API-key auth in Fased. No OAuth/device
sign-in path is exposed for this provider.

| Provider            | Auth env                 | Notes                                   |
| ------------------- | ------------------------ | --------------------------------------- |
| `volcengine`        | `VOLCANO_ENGINE_API_KEY` | Standard ARK endpoint                   |
| `volcengine-coding` | `VOLCANO_ENGINE_API_KEY` | Coding endpoint                         |
| `volcengine-plan`   | `VOLCANO_ENGINE_API_KEY` | Compatibility alias for coding endpoint |

Example default models:

```json5
{
  agents: { defaults: { model: { primary: "volcengine-plan/ark-code-latest" } } },
}
```

Run `fased models list --all --provider volcengine-plan` to inspect the bundled
catalog.

Normal setup shows the current curated Volcano Engine routes:

**`volcengine`**

- `doubao-seed-2-0-pro-260215`
- `doubao-seed-2-0-lite-260215`
- `doubao-seed-2-0-code-preview-260215`
- `deepseek-v3-2-251201`
- `glm-4-7-251222`

**`volcengine-coding` / `volcengine-plan`**

- `ark-code-latest`
- `doubao-seed-2.0-code`
- `doubao-seed-2.0-pro`
- `doubao-seed-2.0-lite`
- `doubao-seed-code`
- `minimax-m2.5`
- `glm-4.7`
- `deepseek-v3.2`
- `kimi-k2.5`

Older runtime models remain compatible when already configured, but they are not
first-run defaults.
