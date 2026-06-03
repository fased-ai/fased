---
read_when:
  - 你想用一个 API key 访问多种 LLM
  - 你想在 Fased 中通过 OpenRouter 运行模型
summary: 使用 OpenRouter 的统一 API 在 Fased 中访问多种模型
title: OpenRouter
x-i18n:
  model: manual
  provider: manual
  source_path: providers/openrouter.md
---

# OpenRouter

OpenRouter 提供 OpenAI-compatible 的统一 API。Fased 使用 `openrouter` provider
和 OpenRouter API key。

## 设置

```bash
fased onboard --auth-choice openrouter-api-key --openrouter-api-key "$OPENROUTER_API_KEY"
```

同一个 API-key 方法也在 **Agent > Models** 中可用。打开 **Agents**，选择
Agent，然后在 Models tab 选择 **OpenRouter**。Fased 没有单独的 OpenRouter
OAuth 登录方式。

## 示例

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/auto" },
    },
  },
}
```

## 注意事项

- 模型引用格式是 `openrouter/<provider>/<model>`。
- `openrouter/auto` 是引导设置默认值；正常 picker 会显示当前 curated 模型列表。
- 运行 `fased models list --all --provider openrouter` 查看当前 catalog。
