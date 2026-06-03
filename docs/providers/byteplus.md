---
summary: "BytePlus ModelArk setup"
title: "BytePlus"
read_when:
  - You want to use BytePlus ModelArk models
  - You need provider ids or API key env vars
---

# BytePlus

Fased supports BytePlus ModelArk model endpoints, including coding aliases used
by onboarding. BytePlus uses API-key auth in Fased. No OAuth/device sign-in path
is exposed for this provider.

| Provider          | Auth env           | Notes                                   |
| ----------------- | ------------------ | --------------------------------------- |
| `byteplus`        | `BYTEPLUS_API_KEY` | Standard BytePlus endpoint              |
| `byteplus-coding` | `BYTEPLUS_API_KEY` | Coding endpoint                         |
| `byteplus-plan`   | `BYTEPLUS_API_KEY` | Compatibility alias for coding endpoint |

Example default model:

```json5
{
  agents: { defaults: { model: { primary: "byteplus-plan/ark-code-latest" } } },
}
```

Run `fased models list --all --provider byteplus-plan` to inspect the bundled
catalog.

Normal setup shows the current curated BytePlus routes:

| Route                               | Models                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `byteplus`                          | `seed-2-0-pro-260328`, `seed-2-0-lite-260228`, `seed-2-0-mini-260215`, `seed-2-0-code-preview-260328`, `deepseek-v3-2-251201`, `glm-4-7-251222`              |
| `byteplus-coding` / `byteplus-plan` | `ark-code-latest`, `dola-seed-2.0-pro`, `dola-seed-2.0-lite`, `dola-seed-2.0-code`, `bytedance-seed-code`, `glm-5.1`, `glm-4.7`, `kimi-k2.5`, `gpt-oss-120b` |

Older runtime models remain compatible when already configured, but they are not
first-run defaults.
