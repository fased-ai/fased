---
summary: Together AI 设置（认证 + 模型选择）
title: Together AI
x-i18n:
  source_path: providers/together.md
---

# Together AI

Together AI 通过统一 OpenAI-compatible API 提供 Kimi、MiniMax、GLM、Qwen、DeepSeek 等模型。

- Provider：`together`
- Auth：`TOGETHER_API_KEY`
- API：OpenAI-compatible
- Base URL：`https://api.together.xyz/v1`

## 快速设置

浏览器：**Agents > Agent > Models > Together AI**。

CLI：

```bash
fased onboard --auth-choice together-api-key
```

非交互式：

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

示例默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.6" },
    },
  },
}
```

## 常见模型

- Kimi K2.6 - 默认高质量 chat/reasoning/vision 模型。
- Kimi K2.5 - 早期 Kimi fallback 路由。
- MiniMax M2.7
- GLM-5.1 / GLM-5
- Qwen3.6 Plus / Qwen3.5
- GPT-OSS 120B / 20B
- DeepSeek V4 Pro
- Qwen3 Coder
- Llama 3.3 70B Instruct
- Gemma 4 31B IT
