---
read_when:
  - 你想在 Fased 中使用 Qwen
  - 你需要当前的 Qwen 设置方式
summary: 在 Fased 中使用 Qwen API key 和 Coding Plan
title: Qwen
x-i18n:
  generated_at: "2026-02-03T07:53:34Z"
  model: manual
  provider: manual
  source_hash: 88b88e224e2fecbb1ca26e24fbccdbe25609be40b38335d0451343a5da53fdd4
  source_path: providers/qwen.md
  workflow: 15
---

# Qwen

Fased 的普通设置现在通过 API key 使用 Qwen：

- **Coding Plan API key**：Alibaba Cloud Coding Plan key（`sk-sp-...`），用于更高配额和 coding-plan 模型。
- **DashScope API key**：标准 Qwen/DashScope API key（`sk-...`），用于兼容模式 API。

Qwen Code 旧的 OAuth 免费层已于 2026-04-15 停用。Fased 不再在 onboarding、CLI provider setup 或正常的 **Agent > Models** 流程中提供旧的 Qwen portal 登录方式。

## 设置

可使用任一正常设置入口：

- Onboarding：选择 **Qwen**，然后选择 **Coding Plan API key** 或 **DashScope API key**。
- Control UI：打开 **Agent > Models**，添加或选择 Qwen，并保存对应 API key。
- CLI：使用 Qwen provider API-key 设置路径，或设置对应环境变量。

## 模型引用

示例：

- `qwen-coding-plan/qwen3.6-plus`
- `qwen-coding-plan/qwen3-coder-plus`
- `qwen/qwen3.6-plus`
- `qwen/qwen3-coder-plus`

运行 `fased models list --all --provider qwen` 查看当前目录。
