---
summary: "Configure Moonshot K2 vs Kimi Coding (separate providers + keys)"
read_when:
  - You want Moonshot K2 (Moonshot Open Platform) vs Kimi Coding setup
  - You need to understand separate endpoints, keys, and model refs
  - You want copy/paste config for either provider
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot provides the Kimi API with OpenAI-compatible endpoints. Configure the
provider, then open **Agents** and use **Agent > Models** to assign
`moonshot/kimi-k2.6` or `kimi-coding/kimi-for-coding` to the selected Agent.

Current normal Kimi model IDs:

{/_moonshot-kimi-k2-ids:start_/ && null}

- `kimi-k2.6`
- `kimi-k2.5`
  {/_moonshot-kimi-k2-ids:end_/ && null}

```bash
fased onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
fased onboard --auth-choice kimi-code-api-key
```

Note: Moonshot and Kimi Coding are separate providers. Keys are not
interchangeable, endpoints differ, and model refs differ. Moonshot uses
`moonshot/...`; Kimi Coding uses `kimi-coding/...`.

## Config snippet (Moonshot API)

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.6" },
      models: {
        // moonshot-kimi-k2-aliases:start
        "moonshot/kimi-k2.6": { alias: "Kimi K2.6" },
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
        // moonshot-kimi-k2-aliases:end
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          // moonshot-kimi-k2-models:start
          {
            id: "kimi-k2.6",
            name: "Kimi K2.6",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32768,
          },
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // moonshot-kimi-k2-models:end
        ],
      },
    },
  },
}
```

## Kimi Coding

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/kimi-for-coding" },
      models: {
        "kimi-coding/kimi-for-coding": { alias: "Kimi for Coding" },
      },
    },
  },
}
```

## Notes

- Moonshot model refs use `moonshot/<modelId>`. Kimi Coding model refs use
  `kimi-coding/<modelId>`.
- Override pricing and context metadata in `models.providers` if needed.
- If Moonshot publishes different context limits for a model, adjust
  `contextWindow` accordingly.
- Use `https://api.moonshot.ai/v1` for the international endpoint, and
  `https://api.moonshot.cn/v1` for the China endpoint.
