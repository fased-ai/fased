---
summary: 通过 LiteLLM Proxy 统一模型访问和成本追踪
title: LiteLLM
x-i18n:
  source_path: providers/litellm.md
---

# LiteLLM

LiteLLM 是 OpenAI-compatible LLM gateway。Fased 可以通过 `litellm` provider 使用你的 LiteLLM proxy，并把上游模型、虚拟 key、日志和成本追踪留给 LiteLLM 管理。

普通浏览器设置：**Agents > Agent > Models > LiteLLM**。

CLI：

```bash
fased onboard --auth-choice litellm-api-key
```

## 手动启动示例

```bash
pip install 'litellm[proxy]'
litellm --model gpt-5.5
```

```bash
export LITELLM_API_KEY="your-litellm-key"
fased
```

Fased 注册 `litellm/default` 作为默认初始引用，然后可以刷新或使用 proxy 暴露的模型 ID。

## 配置

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/default" },
    },
  },
}
```

LiteLLM 的模型目录来自你的 proxy，不是全局固定列表。使用 `curl http://localhost:4000/models`
或 **Agent > Models** 检查当前可用模型。
