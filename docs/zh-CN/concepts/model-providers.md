---
read_when:
  - 你需要按提供商分类的模型设置参考
  - 你需要模型提供商的示例配置或 CLI 新手引导命令
summary: 模型提供商概述，包含示例配置和 CLI 流程
title: 模型提供商
x-i18n:
  generated_at: "2026-02-03T07:46:28Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 14f73e5a9f9b7c6f017d59a54633942dba95a3eb50f8848b836cfe0b9f6d7719
  source_path: concepts/model-providers.md
  workflow: 15
---

# 模型提供商

本页介绍 **LLM/模型提供商**（不是 WhatsApp/Telegram 等聊天渠道）。
关于模型选择规则，请参阅 [/concepts/models](/concepts/models)。

## 快速规则

- 模型引用使用 `provider/model` 格式（例如：`opencode/gpt-5.5`）。
- 如果设置了 `agents.defaults.models`，它将成为允许列表。
- CLI 辅助工具：`fased onboard`、`fased models list`、`fased models set <provider/model>`。

## 内置提供商（pi-ai 目录）

Fased 附带 pi-ai 目录。这些提供商**不需要** `models.providers` 配置；只需设置认证 + 选择模型。

### OpenAI

- 提供商：`openai`
- 认证：`OPENAI_API_KEY`
- 示例模型：`openai/gpt-5.5`
- CLI：`fased onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
}
```

### Anthropic

- 提供商：`anthropic`
- 认证：`ANTHROPIC_API_KEY` 或 `claude setup-token`
- 示例模型：`anthropic/claude-opus-4-6`
- CLI：`fased onboard --auth-choice token`（粘贴 setup-token）或 `fased models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- 提供商：`openai-codex`
- 认证：OAuth (ChatGPT)
- 示例模型：`openai-codex/gpt-5.3-codex`
- CLI：`fased onboard --auth-choice openai-codex` 或 `fased models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- 提供商：`opencode`
- 认证：`OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）
- 示例模型：`opencode/gpt-5.5`
- CLI：`fased onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/gpt-5.5" } } },
}
```

### Google Gemini（API 密钥）

- 提供商：`google`
- 认证：`GEMINI_API_KEY`
- 示例模型：`google/gemini-3-pro-preview`
- CLI：`fased onboard --auth-choice gemini-api-key`

### Google Vertex 和 Gemini CLI

- 提供商：`google-vertex`、`google-gemini-cli`
- 认证：Vertex 使用 gcloud ADC；Gemini CLI 使用自己的认证流程
- Gemini CLI OAuth 作为捆绑插件提供（`google-gemini-cli-auth`，默认禁用）。
  - 启用：`fased plugins enable google-gemini-cli-auth`
  - 登录：`fased models auth login --provider google-gemini-cli --set-default`
  - 注意：你**不需要**将客户端 ID 或密钥粘贴到 `fased.json` 中。CLI 登录流程将令牌存储在 Gateway 网关主机的认证配置文件中。

### Z.AI (GLM)

- 提供商：`zai`
- 认证：`ZAI_API_KEY`
- 示例模型：`zai/glm-4.7`
- CLI：`fased onboard --auth-choice zai-api-key`
  - 别名：`z.ai/*` 和 `z-ai/*` 规范化为 `zai/*`

### Vercel AI Gateway

- 提供商：`vercel-ai-gateway`
- 认证：`AI_GATEWAY_API_KEY`
- 示例模型：`vercel-ai-gateway/openai/gpt-5.5`
- CLI：`fased onboard --auth-choice ai-gateway-api-key`

### 其他内置提供商

- OpenRouter：`openrouter`（`OPENROUTER_API_KEY`）
- 示例模型：`openrouter/anthropic/claude-sonnet-4-5`
- xAI：`xai`（`XAI_API_KEY`）
- Mistral：`mistral`（`MISTRAL_API_KEY`）
- Qwen：`qwen`（`QWEN_API_KEY`）
- Z.AI：`zai`（`ZAI_API_KEY`）
- Qianfan：`qianfan`（`QIANFAN_API_KEY`）
- GitHub Copilot：`github-copilot`（`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`）

## 通过 `models.providers` 配置的提供商（自定义/基础 URL）

使用 `models.providers`（或 `models.json`）添加**自定义**提供商或 OpenAI/Anthropic 兼容的代理。

### Moonshot AI (Kimi)

Moonshot 使用 OpenAI 兼容端点，因此将其配置为自定义提供商：

- 提供商：`moonshot`
- 认证：`MOONSHOT_API_KEY`
- 示例模型：`moonshot/kimi-k2.5`

Kimi K2 模型 ID：

{/_ moonshot-kimi-k2-model-refs:start _/ && null}

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  {/_ moonshot-kimi-k2-model-refs:end _/ && null}

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

Kimi Coding 使用 Moonshot AI 的 Anthropic 兼容端点：

- 提供商：`kimi-coding`
- 认证：`KIMI_API_KEY`
- 示例模型：`kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen

Qwen 普通设置现在使用 API key：

- Coding Plan API key：Alibaba Cloud Coding Plan key（`sk-sp-...`）。
- DashScope API key：标准 Qwen/DashScope key（`sk-...`）。

旧的 Qwen portal OAuth 免费层已于 2026-04-15 停用，因此 Fased 不再在 onboarding、CLI provider setup 或正常的 **Agent > Models** 设置流程中显示该登录方式。参见 [/providers/qwen](/providers/qwen)。

### Synthetic

Synthetic 通过 `synthetic` 提供商提供 Anthropic 兼容模型：

- 提供商：`synthetic`
- 认证：`SYNTHETIC_API_KEY`
- 示例模型：`synthetic/hf:MiniMaxAI/MiniMax-M2.5`
- CLI：`fased onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" }],
      },
    },
  },
}
```

### MiniMax

MiniMax 通过 `models.providers` 配置，因为它使用自定义端点：

- MiniMax（Anthropic 兼容）：`--auth-choice minimax-api`
- 认证：`MINIMAX_API_KEY`

参见 [/providers/minimax](/providers/minimax) 了解设置详情、模型选项和配置片段。

### 通过 Custom Provider 使用 Ollama

Ollama 不是 Fased registry 的一等 provider card。普通设置请使用 **Custom Provider** 指向 Ollama 的 OpenAI 兼容端点：

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "custom/llama3.3" } },
  },
}
```

Base URL 使用 `http://127.0.0.1:11434/v1`，然后在 **Agent > Models** 或 Chat 中选择 Custom Provider 模型。

### 本地代理（LM Studio、vLLM、LiteLLM 等）

示例（OpenAI 兼容）：

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.7",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

注意事项：

- 对于自定义提供商，`reasoning`、`input`、`cost`、`contextWindow` 和 `maxTokens` 是可选的。
  省略时，Fased 默认为：
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 建议：设置与你的代理/模型限制匹配的显式值。

## CLI 示例

```bash
fased onboard --auth-choice opencode-zen
fased models set opencode/gpt-5.5
fased models list
```

另请参阅：[/gateway/configuration](/gateway/configuration) 了解完整配置示例。
