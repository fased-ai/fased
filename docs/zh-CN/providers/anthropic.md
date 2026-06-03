---
read_when:
  - 你想在 Fased 中使用 Anthropic 模型
  - 你想使用 Claude sign-in、setup-token 或 API key
summary: 在 Fased 中通过 sign-in、setup-token 或 API key 使用 Anthropic Claude
title: Anthropic
x-i18n:
  model: manual
  provider: manual
  source_path: providers/anthropic.md
---

# Anthropic（Claude）

Fased 支持三种 Anthropic 认证方式：

- **Sign in (Claude Code OAuth)**：使用 Claude Code OAuth 登录。
- **Token (setup-token)**：用 `claude setup-token` 生成 token 后粘贴。
- **API key**：使用 Anthropic Console API key。

## 在哪里设置

| 入口       | 做什么                                                                       |
| ---------- | ---------------------------------------------------------------------------- |
| Control UI | 打开 **Agents**，选择 Agent，然后在 **Agent > Models** 里选择 Anthropic。    |
| Onboarding | 选择 **Set up model providers**，再选择 Anthropic 的 sign-in/token/API key。 |
| CLI        | 使用 `fased models auth login --provider anthropic --method ...`。           |

## API key

```bash
fased onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

示例：

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } },
}
```

## setup-token

setup-token 由 Claude Code CLI 创建：

```bash
claude setup-token
```

然后在 **Agent > Models** 粘贴，或在 Gateway 主机运行：

```bash
fased models auth setup-token --provider anthropic
fased models auth paste-token --provider anthropic
```

## Prompt caching

Anthropic API key 路线支持 `cacheRetention`：

| 值      | 缓存时长 |
| ------- | -------- |
| `none`  | 不缓存   |
| `short` | 5 分钟   |
| `long`  | 1 小时   |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-7": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

## 1M context beta

对支持的 Opus/Sonnet 模型可以设置：

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-7": {
          params: { context1m: true },
        },
      },
    },
  },
}
```

OAuth/subscription token 路线会自动跳过不兼容的 1M beta header。

## 故障排除

- Claude subscription token 失效时，重新运行 `claude setup-token` 并粘贴到 Gateway 主机。
- 运行 `fased models status` 查看当前认证 profile。
- 新 Agent 不会自动继承另一个 Agent 的模型角色；在 **Agent > Models** 为该 Agent 选择模型。
