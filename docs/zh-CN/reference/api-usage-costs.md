---
read_when:
  - 你想了解哪些功能可能调用付费 API
  - 你需要审核密钥、费用和用量可见性
  - 你正在解释 /status 或 /usage 的费用报告
summary: 审核哪些功能会产生费用、使用了哪些密钥以及如何查看用量
title: API 用量与费用
x-i18n:
  generated_at: "2026-02-01T21:37:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 807d0d88801e919a8246517820644db1e6271d165fa376b2e637f05a9121d8b1
  source_path: reference/api-usage-costs.md
  workflow: 15
---

# API 用量与费用

本文档列出了**可能调用 API 密钥的功能**及其费用的显示位置。重点介绍 Fased 中可能产生提供商用量或付费 API 调用的功能。

## 费用显示位置

**Usage 页面**

- 在 Control UI 中打开 **Usage**，查看 Fased 本地用量账本。
- 它会聚合 chat、channels、tasks、CLI/system runs，以及可用 run logs 中的模型调用。
- 可以按 provider、model、agent、channel、task、session 或 source 分组，查看 token 花在哪里。
- 只有本地 pricing 存在时才显示费用；否则行会标记为 unpriced。

**聊天/会话命令**

- `/status` 显示当前聊天会话模型、上下文估算和最近回复 token 数据。
- `/usage off|tokens|full` 控制当前会话可选的每回复用量页脚。
- `/usage cost` 从存储的 usage records 显示本地费用摘要。

**提供商配额/状态**

- `fased status --usage` 和模型/提供商状态命令可以显示提供商配额窗口或健康状态。
- 提供商配额窗口不是本地 token 用量。把它们当成账号/提供商状态，而不是账单总计。

详情和示例请参阅 [Token 用量与费用](/reference/token-use)。

## 密钥的发现方式

Fased 可以从以下来源获取凭据：

- **认证配置文件**（按智能体配置，存储在 `auth-profiles.json` 中）。
- **环境变量**（例如 `OPENAI_API_KEY`、`BRAVE_API_KEY`、`FIRECRAWL_API_KEY`）。
- **配置文件**（`models.providers.*.apiKey`、`tools.web.search.*`、`tools.web.fetch.firecrawl.*`、`memorySearch.*`、`talk.apiKey`）。
- **Skills**（`skills.entries.<name>.apiKey`），可能会将密钥导出到 Skills 进程的环境变量中。

普通设置请使用 Control UI：

- Agent > Models 连接模型提供商，并选择该 Agent 的 primary/fallback/task models。
- Agent > Services 连接 web search、GitHub、Gmail 和 media 等 API 服务。
- Agent > Skills 配置 skill-local values 和依赖健康状态。
- Advanced Config 仍然是没有友好页面字段的原始逃生口。

## 可能消耗密钥的功能

### 1）核心模型响应（聊天 + 工具）

每次回复或工具调用都使用**当前模型提供商**（OpenAI、Anthropic 等）。这是用量和费用的主要来源。

定价配置请参阅[模型](/providers/models)，显示方式请参阅 [Token 用量与费用](/reference/token-use)。

### 2）媒体理解（音频/图像/视频）

入站媒体可以在回复生成前进行摘要/转录。这会使用模型/提供商 API。

- 音频：OpenAI / Groq / Deepgram（当密钥存在时**自动启用**）。
- 图像：OpenAI / Anthropic / Google。
- 视频：Google。

请参阅[媒体理解](/nodes/media-understanding)。

### 3）记忆嵌入 + 语义搜索

语义记忆搜索在配置为远程提供商时使用**嵌入 API**：

- `memorySearch.provider = "openai"` → OpenAI 嵌入
- `memorySearch.provider = "gemini"` → Gemini 嵌入
- `memorySearch.provider = "voyage"` → Voyage 嵌入
- `memorySearch.provider = "mistral"` → Mistral 嵌入
- 本地嵌入失败时可选回退到远程提供商

你可以使用 `memorySearch.provider = "local"` 保持本地运行（无 API 用量）。

请参阅[记忆](/concepts/memory)。

### 4）网页搜索工具（Brave / 通过 OpenRouter 使用 Perplexity）

`web_search` 使用 API 密钥，可能产生使用费用：

- **Brave Search API**：`BRAVE_API_KEY` 或 `tools.web.search.apiKey`
- **Perplexity**（通过 OpenRouter）：`PERPLEXITY_API_KEY` 或 `OPENROUTER_API_KEY`

**Brave 免费套餐（额度充裕）：**

- **每月 2,000 次请求**
- **每秒 1 次请求**
- **需要信用卡**进行验证（除非升级否则不会收费）

请参阅[网页工具](/tools/web)。

### 5）网页抓取工具（Firecrawl）

`web_fetch` 在存在 API 密钥时可以调用 **Firecrawl**：

- `FIRECRAWL_API_KEY` 或 `tools.web.fetch.firecrawl.apiKey`

如果未配置 Firecrawl，该工具会回退到直接抓取 + 可读性提取（无付费 API）。

请参阅[网页工具](/tools/web)。

### 6）提供商用量快照（状态/健康检查）

某些状态命令会调用**提供商用量端点**以显示配额窗口或认证健康状态。这些通常是低频调用，但仍会访问提供商 API：

- `fased status --usage`
- `fased models status --json`

请参阅[模型 CLI](/cli/models)。

### 7）压缩保护摘要

压缩保护功能可以使用**当前模型**对会话历史进行摘要，运行时会调用提供商 API。

请参阅[会话管理 + 压缩](/reference/session-management-compaction)。

### 8）模型扫描/探测

`fased models scan` 可以探测 OpenRouter 模型，启用探测时会使用 `OPENROUTER_API_KEY`。

请参阅[模型 CLI](/cli/models)。

### 9）语音对话（Talk）

语音对话模式在配置后可以调用 **ElevenLabs**：

- `ELEVENLABS_API_KEY` 或 `talk.apiKey`

请参阅[语音对话模式](/nodes/talk)。

### 10）Skills（第三方 API）

Skills 可以在 `skills.entries.<name>.apiKey` 中存储 `apiKey`。如果 Skills 使用该密钥调用外部 API，则会根据 Skills 的提供商产生费用。

请参阅[Skills](/tools/skills)。
