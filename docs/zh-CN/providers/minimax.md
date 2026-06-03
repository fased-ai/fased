---
read_when:
  - 你想在 Fased 中使用 MiniMax 模型
  - 你需要 MiniMax 设置指南
summary: 在 Fased 中使用 MiniMax M2.7
title: MiniMax
x-i18n:
  source_path: providers/minimax.md
---

# MiniMax

MiniMax 是 Fased 的普通 **Agent > Models** 提供商。当前代码注册表暴露这些 MiniMax 路由：

| 路由             | 用途                                    |
| ---------------- | --------------------------------------- |
| `minimax`        | Global MiniMax API key 路由。           |
| `minimax-cn`     | 中国 MiniMax API key 路由。             |
| `minimax-portal` | MiniMax Coding Plan / portal 登录路由。 |

当前普通模型引用基于 **MiniMax M2.7** 和 **M2.5**。

## 推荐设置

打开 **Agents**，选择 Agent，然后使用 **Agent > Models > MiniMax**。

可选方式：

- **Sign in**：MiniMax portal/coding-plan 路由。
- **API key**：Global 或 CN 托管路由。
- **Highspeed API key**：已有 highspeed 路由时使用。

CLI 用户运行：

```bash
fased configure
```

然后选择模型提供商/认证设置并选择 MiniMax。

## 模型引用

使用注册表里的模型引用：

```text
minimax/MiniMax-M2.7
minimax/MiniMax-M2.7-highspeed
minimax/MiniMax-M2.5
minimax/MiniMax-M2.5-highspeed
minimax-portal/MiniMax-M2.7
minimax-portal/MiniMax-M2.7-highspeed
```

查看本地可用 catalog：

```bash
fased models list --all --provider minimax
fased models list --all --provider minimax-portal
```

## API Key 示例

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.7" },
    },
  },
}
```

CN 路由使用 `MINIMAX_CN_API_KEY`，highspeed 路由使用 `MINIMAX_HIGHSPEED_API_KEY`。

## Portal 登录

Portal 路由使用内置 MiniMax portal auth helper。UI 中使用 **Agent > Models > MiniMax > Sign in**。CLI 中按需启用插件并运行认证流程：

```bash
fased plugins enable minimax-portal-auth
fased gateway restart
fased onboard --auth-choice minimax-portal
```

流程会显示 MiniMax 授权 URL 和用户代码。浏览器完成授权后回到 Fased。

## Fallback 示例

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-7": { alias: "opus" },
        "minimax/MiniMax-M2.7": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-7",
        fallbacks: ["minimax/MiniMax-M2.7"],
      },
    },
  },
}
```

## 本地 MiniMax 文件

通过 LM Studio 或其他本地服务器运行 MiniMax 不属于普通 MiniMax provider 路由。模型由 LM Studio 提供时请使用 [LM Studio](/providers/lmstudio)；其他 OpenAI-compatible 本地服务器请使用 [Custom Provider](/providers/custom)。

## 故障排除

### Unknown MiniMax model

运行：

```bash
fased models list --all --provider minimax
```

然后选择列表中的模型引用。如果路由缺失，在 **Agent > Models** 添加 MiniMax 凭据，或重新运行 `fased configure`。

### Portal 登录不显示

确认 `minimax-portal-auth` 插件已启用，并且启用后已重启 gateway。
