---
read_when:
  - 你想在 Fased 中使用注重隐私的推理服务
  - 你需要 Venice AI 设置指导
summary: 在 Fased 中使用 Venice AI 模型
title: Venice AI
x-i18n:
  generated_at: "2026-02-01T21:36:03Z"
  model: manual
  provider: manual
  source_hash: 2453a6ec3a715c24c460f902dec1755edcad40328de2ef895e35a614a25624cf
  source_path: providers/venice.md
  workflow: 15
---

# Venice AI

Venice AI 提供 OpenAI-compatible 模型端点。Fased 将它注册为
`venice` provider，并在 **Agents > Models** 中为每个 Agent 选择模型角色。

- Provider：`venice`
- Auth：`VENICE_API_KEY`
- API：OpenAI-compatible
- Base URL：`https://api.venice.ai/api/v1`
- 默认模型：`venice/zai-org-glm-5-1`

## 快速设置

1. 在 [venice.ai](https://venice.ai) 创建 API key。
2. 在浏览器打开 **Agents**，选择 Agent，然后进入 **Models > Venice AI**。
3. 填入 API key，选择该 Agent 的 primary、fallback 或 task 模型。

CLI 用户可以用：

```bash
fased onboard --auth-choice venice-api-key
```

非交互式设置：

```bash
fased onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "$VENICE_API_KEY"
```

验证：

```bash
fased agent --model venice/zai-org-glm-5-1 --message "Hello, are you working?"
```

## 模型选择

Fased 的 Venice 选择器使用代码中的内置目录，并可在运行时从 Venice API 刷新。
常用模型包括：

- `venice/zai-org-glm-5-1` - 默认 Venice 模型引用。
- `venice/venice-uncensored-1-2` - Venice 当前 uncensored 模型。
- `venice/qwen-3-6-plus` - 长上下文、视觉、视频能力。
- `venice/qwen3-coder-480b-a35b-instruct-turbo` - 编程模型。
- `venice/qwen3-vl-235b-a22b` - 视觉模型。
- `venice/deepseek-v4-pro` - 强推理模型。
- `venice/kimi-k2-6` - Kimi K2.6。
- `venice/claude-opus-4-7` / `venice/claude-sonnet-4-6` - 通过 Venice 代理的 Claude。
- `venice/openai-gpt-55` / `venice/openai-gpt-54` - 通过 Venice 代理的 OpenAI 模型。
- `venice/gemini-3-1-pro-preview` - Gemini 3.1 Pro Preview。
- `venice/grok-4-20` - Grok 4.20。
- `venice/minimax-m27` - MiniMax M2.7。
- `venice/openai-gpt-oss-120b` - OpenAI GPT-OSS 120B。

如需修改 Agent 模型，请使用 **Agent > Models**。CLI 也可以设置默认模型：

```bash
fased models set venice/zai-org-glm-5-1
fased models set venice/claude-opus-4-7
```

## 配置示例

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: {
    defaults: {
      model: { primary: "venice/zai-org-glm-5-1" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
      },
    },
  },
}
```

## 注意

- Venice 的模型目录会变化；以 **Agent > Models** 中实际显示的列表为准。
- 运行推理始终需要有效的 `VENICE_API_KEY`。
- Venice 的隐私、路由、价格和可用性以 Venice 当前账户/模型文档为准；Fased 只记录你选择的模型引用并请求配置的 Venice API endpoint。
- 如果 gateway 作为 systemd/launchd 服务运行，请确认 `VENICE_API_KEY` 在该进程环境中可见，或存到 Fased 配置/密钥存储中。
