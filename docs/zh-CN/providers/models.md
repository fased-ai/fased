---
read_when:
  - 你想选择一个模型提供商
  - 你想要 LLM 认证和模型选择的快速设置示例
summary: 当前 Fased 注册表的模型提供商快速入门
title: 模型提供商快速入门
x-i18n:
  source_path: providers/models.md
---

# 模型提供商快速入门

Fased 使用同一个提供商注册表驱动 onboarding、CLI、Agent 设置、Chat、任务和频道路由。普通浏览器入口是选中 Agent 后的 **Agent > Models**；旧的独立 Providers 页面不再是首次设置入口。

## 快速开始

1. 打开 **Agents**，选择一个 Agent，然后在 **Agent > Models** 添加凭据、登录、粘贴 token 或配置本地/手动端点。
2. 在同一页选择该 Agent 的 primary、fallback、task 等模型角色。
3. 用 **Chat** 测试 Agent。当前会话可以覆盖模型。
4. 用 **Agent > Channels** 将外部应用路由到该 Agent。
5. 用 **Usage** 查看按 provider、model、Agent、session、task、channel 分组的本地 token 用量。

## 当前提供商顺序

这个列表对应代码里的 `PROVIDER_BRAND_ORDER`。

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

## Catalog 维护

使用 `fased providers refresh` 对比已签入的提供商注册表和经过审查的来源 catalog。使用 `fased providers refresh --write-review` 生成审查文件后再应用模型或能力变化。

本机自定义模型使用 `fased providers models add/remove`。

底层命令见[模型提供商](/concepts/model-providers)。

Provider 文档只列出一等 **Agent > Models** 提供商。Ollama 是 native `/api/chat` provider，不使用 `/v1`；LM Studio 使用 `localhost:1234/v1`；SGLang 和其他 OpenAI-compatible 服务继续使用 [Custom Provider](/providers/custom)。
