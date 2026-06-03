---
summary: 自定义 OpenAI-compatible 或 Anthropic-compatible 端点
title: Custom Provider
x-i18n:
  source_path: providers/custom.md
---

# Custom Provider

Custom Provider 用于 Fased 内置 provider 卡片之外的模型端点。它支持 OpenAI-compatible 和 Anthropic-compatible API。

适用场景：

- 你有 base URL。
- 你知道该端点服务的模型 ID。
- 你知道兼容模式：OpenAI 或 Anthropic。
- 端点可能需要 API key。
- 本地/LAN/私有 VPS 端点需要显式允许 private network。

## 快速设置

浏览器：**Agents > Agent > Models > Custom Provider**。

CLI：

```bash
fased onboard --auth-choice custom-api-key
```

非交互式示例：

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice custom-api-key \
  --custom-base-url "https://models.example.com/v1" \
  --custom-model-id "my-model" \
  --custom-compatibility openai \
  --custom-api-key "$CUSTOM_API_KEY"
```

本地或私有端点加：

```bash
--allow-private-network
```

## 配置形状

```json5
{
  models: {
    mode: "merge",
    providers: {
      "models-example-com": {
        baseUrl: "https://models.example.com/v1",
        api: "openai-completions",
        apiKey: "${CUSTOM_API_KEY}",
        models: [{ id: "my-model", name: "my-model (Custom Provider)" }],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "models-example-com/my-model" },
    },
  },
}
```

普通凭据输入和 Agent 模型角色选择放在 **Agent > Models**。批量编辑或自动化配置再使用 onboarding、CLI flags 或 **Advanced > Config**。
