---
summary: Google Gemini 设置
title: Google Gemini
x-i18n:
  source_path: providers/google.md
---

# Google Gemini

Fased 支持 Gemini API key 路径和 Gemini CLI OAuth 路径。

| 项目        | 值                                                 |
| ----------- | -------------------------------------------------- |
| Provider id | `google`                                           |
| OAuth route | `google-gemini-cli`                                |
| Auth env    | `GEMINI_API_KEY`                                   |
| API         | Google Generative AI                               |
| Base URL    | `https://generativelanguage.googleapis.com/v1beta` |

## API key

普通用户推荐使用 Gemini API key。在浏览器打开 **Agents**，选择 Agent，然后进入
**Agent > Models > Google > API key**。

CLI：

```bash
fased onboard --auth-choice google-api-key
```

示例默认模型：

```json5
{
  agents: { defaults: { model: { primary: "google/gemini-3.1-pro-preview" } } },
}
```

## Gemini CLI 登录

这是单独的 `google-gemini-cli` 路由，依赖 gateway 主机上安装 Gemini CLI 或设置
`GEMINI_CLI_OAUTH_CLIENT_ID`。该流程不是 Google 官方推荐的普通 API key 路径，UI
和 onboarding 会显示风险提示。

```bash
npm install -g @google/gemini-cli
```

如果 gateway 在 VPS 上，登录流程会显示 URL，在本地浏览器完成登录后按提示粘贴回调地址。
