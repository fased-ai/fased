---
summary: Chutes 设置（登录/API key + 模型选择）
title: Chutes
x-i18n:
  source_path: providers/chutes.md
---

# Chutes

Fased 通过 OpenAI-compatible 端点支持 Chutes。普通浏览器入口是 **Agents >
Agent > Models > Chutes**，这里同时负责凭据、登录和该 Agent 的模型角色。

| 项目        | 值                                       |
| ----------- | ---------------------------------------- |
| Provider id | `chutes`                                 |
| Auth env    | `CHUTES_OAUTH_TOKEN` 或 `CHUTES_API_KEY` |
| API         | OpenAI-compatible                        |
| Base URL    | `https://llm.chutes.ai/v1`               |

## 登录方式

Chutes 有两条设置路径：

- **Sign in**：使用 Chutes OAuth client id（`cid_...`）生成登录 URL，完成后保存 OAuth token。
- **API key**：使用 Chutes API key（`cpk_...`），适合普通模型调用。

CLI：

```bash
fased onboard --auth-choice chutes
fased onboard --auth-choice chutes-api-key
```

## 模型

当前代码中的 Chutes 普通设置模型包括：

- `chutes/google/gemma-4-31B-turbo-TEE`
- `chutes/Qwen/Qwen3-32B-TEE`
- `chutes/deepseek-ai/DeepSeek-V3.2-TEE`
- `chutes/zai-org/GLM-5.1-TEE`
- `chutes/moonshotai/Kimi-K2.6-TEE`
- `chutes/Qwen/Qwen3.6-27B-TEE`
- `chutes/Qwen/Qwen3.5-397B-A17B-TEE`
- `chutes/zai-org/GLM-5-TEE`

示例：

```json5
{
  agents: { defaults: { model: { primary: "chutes/zai-org/GLM-5.1-TEE" } } },
}
```

运行 `fased models list --all --provider chutes` 可查看本机运行时目录。
