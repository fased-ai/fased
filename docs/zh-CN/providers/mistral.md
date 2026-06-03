---
summary: Mistral 模型和 Voxtral 转写设置
title: Mistral
x-i18n:
  source_path: providers/mistral.md
---

# Mistral

Fased 支持 Mistral 文本/视觉模型路由（`mistral/...`），也支持通过 Voxtral 做媒体音频转写。Mistral 还可用于 memory embedding。

## 设置

浏览器：**Agents > Agent > Models > Mistral**。

CLI：

```bash
fased onboard --auth-choice mistral-api-key
fased onboard --mistral-api-key "$MISTRAL_API_KEY"
```

示例：

```json5
{
  env: { MISTRAL_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "mistral/mistral-medium-3.5" } } },
}
```

## 当前模型

- `mistral/mistral-medium-3.5`
- `mistral/mistral-small-2603`
- `mistral/mistral-large-2512`
- `mistral/mistral-medium-2508`
- `mistral/devstral-2512`
- `mistral/magistral-medium-2509`
- `mistral/magistral-small-2509`
- `mistral/ministral-14b-2512`
- `mistral/ministral-8b-2512`
- `mistral/ministral-3b-2512`

`mistral-medium-3.5`、`mistral-small-2603` 和 `magistral-medium-2509`
会暴露 reasoning 控制，Fased 会映射到 Mistral API 的 `reasoning_effort`。

## Voxtral 音频转写

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```
