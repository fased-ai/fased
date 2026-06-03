---
summary: Volcano Engine ARK 设置
title: Volcano Engine
x-i18n:
  source_path: providers/volcengine.md
---

# Volcano Engine

Fased 支持 Volcano Engine ARK 模型端点，包括 onboarding 使用的 coding/plan 路由。这个 provider 使用 API key；没有 OAuth/device sign-in。

| Provider            | Auth env                 | 说明                     |
| ------------------- | ------------------------ | ------------------------ |
| `volcengine`        | `VOLCANO_ENGINE_API_KEY` | 标准 ARK endpoint        |
| `volcengine-coding` | `VOLCANO_ENGINE_API_KEY` | Coding endpoint          |
| `volcengine-plan`   | `VOLCANO_ENGINE_API_KEY` | Coding endpoint 兼容别名 |

在 **Agent > Models** 中保存对应 API key 并选择模型角色。

示例：

```json5
{
  agents: { defaults: { model: { primary: "volcengine-plan/ark-code-latest" } } },
}
```

## 当前普通设置模型

- `volcengine/doubao-seed-2-0-pro-260215`
- `volcengine/doubao-seed-2-0-lite-260215`
- `volcengine/doubao-seed-2-0-mini-260215`
- `volcengine/doubao-seed-2-0-code-preview-260215`
- `volcengine/deepseek-v3-2-251201`
- `volcengine/glm-4-7-251222`
- `volcengine-plan/ark-code-latest`
- `volcengine-plan/doubao-seed-2.0-code`
- `volcengine-plan/minimax-m2.5`
- `volcengine-plan/deepseek-v3.2`
- `volcengine-plan/kimi-k2.5`
