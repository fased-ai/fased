---
summary: xAI Grok 设置
title: xAI
x-i18n:
  source_path: providers/xai.md
---

# xAI

Fased 通过 OpenAI-compatible API 支持 xAI Grok 模型。

| 项目        | 值                    |
| ----------- | --------------------- |
| Provider id | `xai`                 |
| Auth env    | `XAI_API_KEY`         |
| API         | OpenAI-compatible     |
| Base URL    | `https://api.x.ai/v1` |

在 **Agent > Models > xAI** 保存 API key，然后为选中的 Agent 选择模型角色。

示例：

```json5
{
  agents: { defaults: { model: { primary: "xai/grok-4.3" } } },
}
```

当前普通设置模型：

- `xai/grok-4.3`
- `xai/grok-4.20-multi-agent-0309`
- `xai/grok-4.20-0309-reasoning`
- `xai/grok-4.20-0309-non-reasoning`

旧 Grok 模型不再作为普通首次设置选项显示。已有显式配置不会被自动删除。
