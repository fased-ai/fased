---
summary: 使用 vLLM 本地 OpenAI-compatible 服务
title: vLLM
x-i18n:
  source_path: providers/vllm.md
---

# vLLM

vLLM 可以把本地或自托管模型暴露为 OpenAI-compatible HTTP API。Fased 通过
`vllm` provider 连接该端点。

默认本地地址：

- `http://127.0.0.1:8000/v1`

## 快速设置

1. 启动 vLLM 的 OpenAI-compatible server。
2. 设置一个 opt-in key。如果你的服务没有认证，任意值即可：

```bash
export VLLM_API_KEY="vllm-local"
```

3. 在 **Agent > Models** 选择或添加 `vllm/<model-id>`。

## 自动发现

当 `VLLM_API_KEY` 存在，并且没有显式配置 `models.providers.vllm` 时，Fased 会请求：

```text
GET http://127.0.0.1:8000/v1/models
```

如果你显式配置了 provider，Fased 不再自动发现，模型需要手动写入配置。

## 显式配置

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [{ id: "your-model-id", name: "Local vLLM Model" }],
      },
    },
  },
}
```

本地、LAN 或私有 VPS 端点需要 `request.allowPrivateNetwork: true`。
