---
read_when:
  - 你想在 Fased 中使用 Xiaomi MiMo 模型
  - 你需要设置 XIAOMI_API_KEY
summary: 在 Fased 中使用 Xiaomi MiMo 模型
title: Xiaomi MiMo
x-i18n:
  generated_at: "2026-02-01T21:36:15Z"
  model: manual
  provider: manual
  source_hash: 366fd2297b2caf8c5ad944d7f1b6d233b248fe43aedd22a28352ae7f370d2435
  source_path: providers/xiaomi.md
  workflow: 15
---

# Xiaomi MiMo

Xiaomi MiMo 是 **MiMo** 模型的 API 平台。它提供与 OpenAI 和 Anthropic 格式兼容的 REST API，并使用 API 密钥进行身份验证。请在 [Xiaomi MiMo 控制台](https://platform.xiaomimimo.com/#/console/api-keys) 中创建你的 API 密钥。Fased 使用 `xiaomi` 提供商配合 Xiaomi MiMo API 密钥。

## 模型概览

- **mimo-v2.5-pro**：当前默认模型，支持推理和图像输入，1M token 上下文。
- **mimo-v2.5**：当前均衡模型，支持推理和图像输入，1M token 上下文。
- **mimo-v2-pro**：大上下文推理文本模型。
- **mimo-v2-omni**：支持文本和图像输入的多模态模型。
- **mimo-v2-flash**：快速、低成本文本模型。
- 基础 URL：`https://api.xiaomimimo.com/v1`
- API：OpenAI 兼容 chat completions。
- 授权方式：`Bearer $XIAOMI_API_KEY`

## CLI 设置

```bash
fased onboard --auth-choice xiaomi-api-key
# 或非交互式
fased onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## 配置片段

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2.5-pro" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2.5-pro",
            name: "Xiaomi MiMo V2.5 Pro",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 131072,
          },
        ],
      },
    },
  },
}
```

## 备注

- 默认模型引用：`xiaomi/mimo-v2.5-pro`。
- 快速模型引用：`xiaomi/mimo-v2-flash`。
- 当设置了 `XIAOMI_API_KEY`（或存在身份验证配置文件）时，该提供商会自动注入。
- 有关提供商规则，请参阅 [/concepts/model-providers](/concepts/model-providers)。
