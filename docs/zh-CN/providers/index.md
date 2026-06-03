---
read_when:
  - 你想选择一个模型提供商
  - 你需要快速了解当前支持的 LLM 后端
summary: Fased 提供商注册表支持的模型提供商
title: 模型提供商
---

# 模型提供商

Fased 使用同一个提供商注册表驱动 onboarding、CLI、Agent 设置、Chat、任务和频道路由。普通浏览器设置入口是选中 Agent 后的 **Agent > Models**；左侧导航里没有面向普通用户的独立 Providers 页面。

聊天应用频道（Telegram、Discord、WhatsApp、Slack 等）请看[频道](/channels)。

## 当前顺序

这个列表对应代码里的 `src/providers/registry.ts` / `PROVIDER_BRAND_ORDER`。Provider 文档只列出这些一等 **Agent > Models** 提供商。

- [OpenAI](/providers/openai)
- [Anthropic](/providers/anthropic)
- [Chutes](/providers/chutes)
- [Ollama](/providers/ollama)
- [LM Studio](/providers/lmstudio)
- [vLLM](/providers/vllm)
- [MiniMax](/providers/minimax)
- [Moonshot AI](/providers/moonshot)
- [Google](/providers/google)
- [xAI](/providers/xai)
- [Mistral AI](/providers/mistral)
- [Volcano Engine](/providers/volcengine)
- [BytePlus](/providers/volcengine)
- [OpenRouter](/providers/openrouter)
- [Qwen](/providers/qwen)
- [Z.AI](/providers/zai)
- [Qianfan](/providers/qianfan)
- [Copilot](/providers/github-copilot)
- [Vercel AI](/providers/vercel-ai-gateway)
- [OpenCode Zen](/providers/opencode)
- [Xiaomi](/providers/xiaomi)
- [Synthetic](/providers/synthetic)
- [Together AI](/providers/together)
- [Hugging Face](/providers/huggingface)
- [Venice AI](/providers/venice)
- [LiteLLM](/providers/litellm)
- [Cloudflare AI](/providers/cloudflare-ai-gateway)
- [Custom Provider](/providers/custom)

## 流程

1. 在 **Agent > Models** 添加 API key、token、登录配置、本地 URL 或自定义端点。
2. 在同一页为该 Agent 选择 primary、fallback、task 等模型角色。
3. 在 Chat 中测试 Agent，并可为当前会话临时覆盖模型。
4. 在 **Agent > Channels** 将 Telegram、Discord 等频道路由到 Agent。

底层注册表规则、刷新、模型元数据和本地端点请看[模型提供商](/concepts/model-providers)。
