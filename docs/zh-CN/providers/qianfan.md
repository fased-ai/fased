---
summary: 使用千帆统一 API 在 Fased 中接入多种模型
title: 千帆（Qianfan）
x-i18n:
  source_path: providers/qianfan.md
---

# 千帆（Qianfan）

千帆是百度智能云的 MaaS 平台。Fased 通过 OpenAI-compatible 接口把它注册为
`qianfan` provider，并在 **Agent > Models** 中为选中的 Agent 配置凭据和模型角色。

## 前置条件

1. 百度智能云账号。
2. 已开通千帆 API。
3. 千帆控制台中的 API key，格式通常类似 `bce-v3/ALTAK-...`。

## 设置

浏览器中打开 **Agents**，选择 Agent，然后进入 **Agent > Models > Qianfan**。
保存 API key 后，为该 Agent 选择 primary、fallback 或 task 模型。

CLI 设置：

```bash
fased onboard --auth-choice qianfan-api-key
```

## 当前模型

首轮设置使用代码中的千帆模型表：

- `qianfan/ernie-5.1` - 默认旗舰模型。
- `qianfan/ernie-5.0`
- `qianfan/ernie-5.0-thinking-latest`
- `qianfan/ernie-5.0-thinking-preview`
- `qianfan/ernie-x1.1`
- `qianfan/ernie-x1-turbo-32k`
- `qianfan/deepseek-v4-pro`
- `qianfan/deepseek-v4-flash`
- `qianfan/deepseek-v3.2`

## 参考

- [Model Providers](/concepts/model-providers)
- [Agent Setup](/concepts/agent)
- [千帆 API 文档](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
- [千帆模型列表](https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j)
