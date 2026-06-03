---
summary: 使用 native Ollama 本地模型
title: Ollama
x-i18n:
  source_path: providers/ollama.md
---

# Ollama

Ollama 是 Fased 的一等 **Agent > Models** provider。Fased 使用 Ollama native
`/api/chat`，不要把 base URL 写成 `/v1`。

默认地址：

- `http://127.0.0.1:11434`

## 快速设置

1. 安装并启动 Ollama。
2. 拉取模型，例如：

```bash
ollama pull llama3.3
```

3. 打开 **Agents > 选中的 Agent > Models > Ollama**。
4. 保持 base URL 为 `http://127.0.0.1:11434`，选择或输入模型 id。

如果本地 Ollama 没有启用认证，可以不填 token。Fased 会保存一个本地 marker，
让 provider 可以注册，但不会把它当成真实密钥。

## 模型发现

Fased 会读取：

```text
GET http://127.0.0.1:11434/api/tags
```

发现的模型会显示为 `ollama/<model-id>`。本地模型成本记为 0。

## 安全

Ollama 是私有网络 provider。请把它放在 localhost、可信 LAN 或 tailnet 上。只有在
Agent 里显式配置后，Fased 才会把它作为模型路由使用。
