---
read_when:
  - 你想在 Fased 中使用 Z.AI / GLM 模型
  - 你需要简单的 ZAI_API_KEY 配置
summary: 在 Fased 中使用智谱 AI（GLM 模型）
title: Z.AI
x-i18n:
  generated_at: "2026-02-01T21:36:13Z"
  model: manual
  provider: manual
  source_hash: 2c24bbad86cf86c38675a58e22f9e1b494f78a18fdc3051c1be80d2d9a800711
  source_path: providers/zai.md
  workflow: 15
---

# Z.AI

Z.AI 是 **GLM** 模型的 API 平台。它为 GLM 提供 REST API，并使用 API 密钥进行身份验证。请在 Z.AI 控制台中创建你的 API 密钥。Fased 通过 `zai` 提供商配合 Z.AI API 密钥使用。

## CLI 设置

```bash
fased onboard --auth-choice zai-api-key
# 或非交互式
fased onboard --zai-api-key "$ZAI_API_KEY"
```

## 配置片段

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
}
```

## 注意事项

- GLM 模型通过 Z.AI provider 以 `zai/<model>` 的形式提供（例如：`zai/glm-5.1`）。
- 当前首选模型包括 `glm-5.1`、`glm-5`、`glm-5-turbo`、`glm-4.7`、
  `glm-4.7-flashx` 和 `glm-4.7-flash`。
- Z.AI 使用 Bearer 认证方式配合你的 API 密钥。
