---
summary: 使用 LM Studio 本地模型服务器
title: LM Studio
x-i18n:
  source_path: providers/lmstudio.md
---

# LM Studio

LM Studio 是 Fased 的一等 **Agent > Models** provider。Fased 通过 LM Studio 的
OpenAI-compatible chat endpoint 调用模型，并从本地模型 API 发现已加载模型。

默认地址：

- `http://127.0.0.1:1234/v1`

## 快速设置

1. 安装 LM Studio。
2. 下载或加载一个模型。
3. 启动 LM Studio local server。
4. 打开 **Agents > 选中的 Agent > Models > LM Studio**。
5. 保持 base URL 为 `http://127.0.0.1:1234/v1`，选择模型 id。

如果 LM Studio 没有启用认证，可以不填 token。Fased 会保存一个本地 marker。

## 模型发现

Fased 会读取：

```text
GET http://127.0.0.1:1234/api/v1/models
```

发现的模型会显示为 `lmstudio/<model-id>`。

## 安全

LM Studio 是私有网络 provider。请只在 localhost、可信 LAN 或 tailnet 上开放。公网模型 provider 不需要 `request.allowPrivateNetwork`，本地 provider 需要。
