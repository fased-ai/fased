---
read_when:
  - 你想在 Fased 中使用 OpenAI 模型
  - 你想使用 ChatGPT 登录而不是 API key
summary: 在 Fased 中通过 API key 或 ChatGPT 登录使用 OpenAI
title: OpenAI
x-i18n:
  model: manual
  provider: manual
  source_path: providers/openai.md
---

# OpenAI

Fased 把 OpenAI 显示为一个品牌，但有两个实际认证路线：

- **OpenAI API key**：使用 OpenAI Platform API，模型引用是 `openai/*`。
- **OpenAI sign-in**：使用 ChatGPT 登录，内部兼容路线是 `openai-codex/*`。

不要手动混用前缀。先选择认证方式，再在 **Agent > Models** 或 Chat 中选择该方式可用的模型。

## 在哪里设置

| 入口       | 做什么                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Control UI | 打开 **Agents**，选择 Agent，然后在 **Agent > Models** 里选择 OpenAI。 |
| Onboarding | 选择 **Set up model providers**，再选择 OpenAI 的 Sign in 或 API key。 |
| CLI        | 使用 `fased onboard --auth-choice openai-codex` 或 `openai-api-key`。  |

## OpenAI API key

适合直接 API 访问和按量计费。

```bash
fased onboard --auth-choice openai-api-key
# 或非交互式
fased onboard --openai-api-key "$OPENAI_API_KEY"
```

示例：

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
}
```

## OpenAI sign-in

适合使用 ChatGPT 登录访问 Fased 支持的 sign-in 模型。

```bash
fased onboard --auth-choice openai-codex

# 或直接运行登录流程
fased models auth login --provider openai-codex
```

示例：

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.5" } } },
}
```

## 传输设置

`openai-codex/*` sign-in 模型使用 Fased 管理的 OpenAI sign-in transport。
需要强制流式路径时，可以设置：

```json5
{
  agents: {
    defaults: {
      models: {
        "openai-codex/gpt-5.5": {
          params: { transport: "auto" },
        },
      },
    },
  },
}
```

可选值：`auto`、`sse`、`websocket`。

## 注意事项

- 模型引用始终使用 `provider/model`。
- **Agent > Models** 保存 OpenAI 凭据和该 Agent 的模型角色。
- Chat 可以为当前会话选择一个临时模型。
