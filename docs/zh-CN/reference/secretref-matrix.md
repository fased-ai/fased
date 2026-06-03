---
title: "SecretRef Matrix"
summary: "哪些 Fased 凭据字段支持 SecretRef，以及应该用哪些工具管理"
read_when:
  - 你要把凭据移出明文配置
  - 你要审核 provider、skill、Google Chat、web、talk 或 auth-profile secrets
  - 你要决定使用 env、file 还是 exec-backed secret references
---

# SecretRef Matrix

Fased 支持 `SecretRef` 对象，让凭据保留在环境变量、本地 secret 文件或可信 resolver 命令中，而不是直接写进明文配置。

对象形状：

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

明文字符串仍然可用。SecretRef 是可选的，但对 hosted gateway、共享机器和难以轮换的凭据更安全。

## Secret sources

| Source | 适合场景                                               | Ref 示例                                                                   | Provider config                                                        |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `env`  | 本地或 hosted env vars                                 | `{ source: "env", provider: "default", id: "OPENAI_API_KEY" }`             | 可选。`default` env provider 不需要额外配置。                          |
| `file` | mounted JSON secret files 或单值 secret files          | `{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }` | `secrets.providers.filemain = { source: "file", path, mode }`          |
| `exec` | 1Password、Vault、`sops` 或自定义可信 resolver command | `{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }`     | `secrets.providers.vault = { source: "exec", command, args, passEnv }` |

验证和运行时行为见 [Secrets Management](/gateway/secrets)。简要规则：required ref 无法解析时 startup 失败；reload 时如果新 ref 失败，运行时保留 last-known-good snapshot。

## 字段矩阵

### Model providers

| Field                                              | 支持 SecretRef | Managed by                                           | Notes                                                                                  |
| -------------------------------------------------- | -------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `models.providers.<provider>.apiKey`               | Yes            | Agent > Models, `fased models`, `fased secrets`      | 不使用 auth profiles 时的 provider-level API key。                                     |
| `auth-profiles.json profiles.<profileId>.keyRef`   | Yes            | Agent > Models, `fased models auth`, `fased secrets` | `type: "api_key"` auth profiles 使用。`keyRef` 存在时 runtime 忽略 plaintext `key`。   |
| `auth-profiles.json profiles.<profileId>.tokenRef` | Yes            | Agent > Models, `fased models auth`, `fased secrets` | `type: "token"` auth profiles 使用。`tokenRef` 存在时 runtime 忽略 plaintext `token`。 |
| OAuth credential files                             | No             | Provider login flow                                  | OAuth credentials 是独立存储。SecretRef migration 不会重写 OAuth stores。              |

### Skills and plugins

| Field                                 | 支持 SecretRef            | Managed by              | Notes                                                                                 |
| ------------------------------------- | ------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `skills.entries.<skillKey>.apiKey`    | runtime 支持              | Agent > Skills, secrets | Skill `apiKey` 可在 skill env injection 前通过 runtime snapshot 解析。                |
| `skills.entries.<skillKey>.env`       | 无通用 SecretRef contract | Agent > Skills          | 非 secret env values 放这里。secrets 优先使用 `apiKey` 或 skill-specific credential。 |
| `plugins.entries.<pluginId>.apiKey`   | 无稳定 top-level field    | Extensions              | 不要依赖 generic plugin `apiKey`。plugin credentials 属于 plugin-defined config。     |
| `plugins.entries.<pluginId>.config.*` | Plugin-defined            | Extensions              | 具体 credential path 由 plugin manifest/UI hints 和 plugin docs 定义。                |

安装 skill 或 plugin 不会授予 wallet、mining、tool 或 autonomous task access。那些 grant 需要单独审核。

### Google Chat

| Field                                                 | 支持 SecretRef | Managed by                        | Notes                                                      |
| ----------------------------------------------------- | -------------- | --------------------------------- | ---------------------------------------------------------- |
| `channels.googlechat.serviceAccount`                  | Yes            | Agent > Channels, `fased secrets` | 可以是 inline JSON、string JSON 或 SecretRef。             |
| `channels.googlechat.serviceAccountRef`               | Yes            | Agent > Channels, `fased secrets` | 显式 ref field。建议用它避免 service-account JSON 进配置。 |
| `channels.googlechat.accounts.<id>.serviceAccount`    | Yes            | Agent > Channels, `fased secrets` | Per-account 版本。                                         |
| `channels.googlechat.accounts.<id>.serviceAccountRef` | Yes            | Agent > Channels, `fased secrets` | Per-account 显式 ref field。                               |

其他 channel token 可能仍使用 env vars 或 focused channel setup screens。只有没有友好 SecretRef form 的字段才用 Advanced Config。

### Web, fetch, and talk services

| Field                                | 支持 SecretRef | Managed by                               | Notes                                                      |
| ------------------------------------ | -------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `tools.web.search.apiKey`            | Yes            | Agent > Services, Advanced Config        | Brave Search 或 selected built-in/plugin search provider。 |
| `tools.web.search.perplexity.apiKey` | Yes            | Agent > Services, Advanced Config        | Perplexity/OpenRouter path。                               |
| `tools.web.search.grok.apiKey`       | Yes            | Agent > Services, Advanced Config        | xAI/Grok web search path。                                 |
| `tools.web.search.gemini.apiKey`     | Yes            | Agent > Services, Advanced Config        | Gemini grounded search path。                              |
| `tools.web.search.kimi.apiKey`       | Yes            | Agent > Services, Advanced Config        | Moonshot/Kimi search path。                                |
| `tools.web.fetch.firecrawl.apiKey`   | Yes            | Agent > Services, Advanced Config        | `web_fetch` 的 Firecrawl fallback。                        |
| `talk.apiKey`                        | Yes            | Agent > Services / Talk, Advanced Config | Legacy global talk API key。                               |
| `talk.providers.<provider>.apiKey`   | Yes            | Agent > Services / Talk, Advanced Config | Provider-specific TTS credentials。                        |

这些字段 schema/runtime 支持 SecretRef，但 `fased secrets configure/apply` migration helper 比 schema 范围窄。如果 helper 没列出某字段，用 focused UI 或 Advanced Config 保存后运行 `fased secrets audit --check`。

### Memory search

| Field                                        | 支持 SecretRef   | Managed by                                   | Notes                                                              |
| -------------------------------------------- | ---------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `agents.defaults.memorySearch.remote.apiKey` | Runtime-tolerant | Agent > Memory, Memory page, Advanced Config | custom remote embedding endpoints。常见 provider 优先用 auth/env。 |
| `agents.list[].memorySearch.remote.apiKey`   | Runtime-tolerant | Agent > Memory, Advanced Config              | Per-Agent override。保存后用 memory status/search 检查。           |

Memory search 对常见 embedding providers 也可从 provider auth/config/env 解析 API key。见 [Memory Config](/reference/memory-config)。

## 工具覆盖

| Tool                                | Scope                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `fased secrets audit --check`       | 查找明文和 unresolved refs：model providers、skill API keys、Google Chat service accounts、auth-profile refs。 |
| `fased secrets configure`           | 为主要静态 credential fields 构建 SecretRef provider config 和 migration plans。                               |
| `fased secrets apply --from <plan>` | reviewed migration plan 通过 preflight 后应用。                                                                |
| `fased secrets reload`              | 重新解析 refs 并原子替换 runtime snapshot。                                                                    |
| Focused Control UI pages            | 普通设置优先使用 Agent > Models、Services、Skills、Channels。                                                  |
| Advanced Config                     | 没有友好 form 的逃生口。                                                                                       |

## 安全默认值

- 本地和 hosted secret managers 暴露 env vars 时优先用 `env`。
- Docker/Podman/Kubernetes-style hosting 的 mounted secrets 优先用 `file`。
- `exec` 只用于可信、绝对路径、已审核、环境 allowlist 很小的 resolver command。
- 不要把 wallet seed phrases、private keys 或 passkeys 存入 SecretRef 字段。
- 不要把 resolved key 当成 Agent access。Services 连接凭据；Agent > Tools 和 Agent > Skills 决定选定 Agent 可以使用什么。
