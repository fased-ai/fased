---
summary: BytePlus ModelArk 设置
title: BytePlus
x-i18n:
  source_path: providers/byteplus.md
---

# BytePlus

Fased 支持 BytePlus ModelArk 模型端点，包括 onboarding 使用的 coding/plan
路由。这个 provider 使用 API key；没有 OAuth/device sign-in。

| Provider          | Auth env           | 说明                     |
| ----------------- | ------------------ | ------------------------ |
| `byteplus`        | `BYTEPLUS_API_KEY` | 标准 BytePlus endpoint   |
| `byteplus-coding` | `BYTEPLUS_API_KEY` | Coding endpoint          |
| `byteplus-plan`   | `BYTEPLUS_API_KEY` | Coding endpoint 兼容别名 |

在 **Agent > Models** 中保存对应 API key 并选择模型角色。

示例：

```json5
{
  agents: { defaults: { model: { primary: "byteplus-plan/ark-code-latest" } } },
}
```

## 当前普通设置模型

- `byteplus/seed-2-0-pro-260328`
- `byteplus/seed-2-0-lite-260228`
- `byteplus/seed-2-0-mini-260215`
- `byteplus/seed-2-0-code-preview-260328`
- `byteplus/deepseek-v3-2-251201`
- `byteplus/glm-4-7-251222`
- `byteplus-plan/ark-code-latest`
- `byteplus-plan/dola-seed-2.0-pro`
- `byteplus-plan/glm-5.1`
- `byteplus-plan/kimi-k2.5`
- `byteplus-plan/gpt-oss-120b`
