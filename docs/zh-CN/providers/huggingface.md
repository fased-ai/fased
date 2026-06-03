---
summary: Hugging Face Inference 设置（认证 + 模型选择）
title: Hugging Face Inference
x-i18n:
  source_path: providers/huggingface.md
---

# Hugging Face Inference

Hugging Face Inference Providers 通过一个 router API 提供 OpenAI-compatible chat completions。Fased 使用 chat completions 路由，不把图像生成、embedding 或语音端点暴露为这个 provider。

- Provider：`huggingface`
- Auth：`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`
- API：OpenAI-compatible
- Base URL：`https://router.huggingface.co/v1`

## 快速设置

1. 在 Hugging Face 创建 fine-grained token，并启用 **Make calls to Inference Providers** 权限。
2. 运行 onboarding：

```bash
fased onboard --auth-choice huggingface-api-key
```

3. 在浏览器打开 **Agents**，选择 Agent，然后使用 **Agent > Models** 为该 Agent 设置 Hugging Face 模型角色。

非交互式：

```bash
fased onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

## 模型发现

Fased 会请求：

```text
GET https://router.huggingface.co/v1/models
```

有 token 时可看到更完整的 runtime 列表；请求失败时使用代码内置目录。

## 内置示例模型

- `huggingface/openai/gpt-oss-120b`
- `huggingface/deepseek-ai/DeepSeek-V4-Pro`
- `huggingface/moonshotai/Kimi-K2.6`
- `huggingface/MiniMaxAI/MiniMax-M2.7`
- `huggingface/zai-org/GLM-5.1`
- `huggingface/Qwen/Qwen3.6-35B-A3B`
- `huggingface/Qwen/Qwen3.5-397B-A17B`
- `huggingface/Qwen/Qwen3-Coder-Next`
- `huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct`
- `huggingface/google/gemma-4-31B-it`

可以在模型 ID 后添加 `:fastest`、`:cheapest` 或具体 backend 后缀，例如 `:together`。
