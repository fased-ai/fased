---
read_when:
  - 你正在对接提供商使用量/配额界面
  - 你需要解释使用量跟踪行为或认证要求
summary: 使用量跟踪界面及凭据要求
title: 使用量跟踪
x-i18n:
  generated_at: "2026-02-01T20:24:46Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6f6ed2a70329b2a6206c327aa749a84fbfe979762caca5f0e7fb556f91631cbb
  source_path: concepts/usage-tracking.md
  workflow: 14
---

# 使用量跟踪

## 功能简介

- Fased 本地记录的模型调用账本。
- 当 usage records 存在时，聚合 chat、channel、task、CLI/system、worker/subagent runs。
- 可按 provider、model、Agent、channel、task、session 和 source 分组。
- 显示 input、output、cache read/write、total tokens，以及存在 pricing 时的 cost。
- pricing unknown 时标记为 unpriced，而不是隐藏记录。

Provider account quota/status 与本地 token accounting 是两回事。Usage page 不应在 transcript 或 task run-log usage record 可用时，把 session context snapshot 当成 billing truth。

## 展示位置

- **Usage** page (`/usage`)：七天本地 usage 历史，可过滤所有 Agents 或选定 Agent。
- **Dashboard** (`/dash`)：compact 七天 token widget。
- Agent Setup：选定 Agent 的 compact Usage card。
- 聊天中的 `/status`：包含 session tokens + estimated cost（仅 API key）的状态卡片。当前 model provider 可用时显示 provider usage。
- 聊天中的 `/usage off|tokens|full`：每次响应的使用量页脚（OAuth 仅显示 token）。
- 聊天中的 `/usage cost`：从 Fased session logs 汇总本地费用。
- CLI：`fased status --usage` 打印完整的按提供商分类的详细信息。
- macOS 菜单栏：上下文菜单下的"使用量"部分（仅在可用时显示）。

## 提供商及凭据

- **Anthropic (Claude)**：认证配置中的 OAuth 令牌。
- **GitHub Copilot**：认证配置中的 OAuth 令牌。
- **Gemini CLI**：认证配置中的 OAuth 令牌。
- **OpenAI sign-in**：认证配置中的 OAuth 令牌（存在时使用 accountId）。
- **MiniMax**：API 密钥（编程计划密钥；`MINIMAX_CODE_PLAN_KEY` 或 `MINIMAX_API_KEY`）；使用 5 小时编程计划时间窗口。
- **Xiaomi**：配置时使用 API key；provider quota surfaces 可能为空。
- **z.ai**：通过环境变量/配置/认证存储提供的 API 密钥。

如果没有匹配的 OAuth/API 凭据，使用量信息将被隐藏。

使用 **Usage** 做本地 token accounting。使用 provider auth/status surfaces 查看 provider quota 或 account health。只有需要 friendly usage view 背后的 raw model/provider status snapshots 时，才打开 **Advanced > Debug**。
