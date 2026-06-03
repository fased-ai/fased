---
read_when:
  - 调试或配置 WebChat 访问
summary: 浏览器 Chat 和原生 WebChat 如何通过 Gateway WebSocket 工作
title: WebChat
x-i18n:
  generated_at: "2026-02-03T10:13:28Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b5ee2b462c8c979ac27f80dea0cf12cf62b3c799cf8fd0a7721901e26efeb1a0
  source_path: web/webchat.md
  workflow: 15
---

# Chat 和 WebChat

浏览器 **Chat** 页面 `/chat` 和原生 macOS/iOS WebChat 客户端都直接连接 Gateway WebSocket。

## 它是什么

- 选定 Agent 和会话的实时聊天界面。
- 使用与其他渠道相同的会话和路由规则。
- 确定性路由：回复返回到当前浏览器/原生聊天会话，而不是返回到某个渠道路由。
- 浏览器 Chat 是本地操作员的常规聊天入口。
- 原生 WebChat 客户端不需要单独的本地静态服务器。

## 快速开始

1. 启动 Gateway 网关。
2. 在 Control UI 中打开 **Chat**，或打开原生 WebChat UI。
3. 确保已配置 Gateway 网关认证（默认需要，即使在 loopback 上）。

## 工作原理（行为）

- UI 连接到 Gateway 网关 WebSocket 并使用 `chat.history`、`chat.send` 和 `chat.inject`。
- `chat.history` 会为了稳定性限制返回内容：Gateway 可能截断长文本字段、省略重型元数据，并用 `[chat.history omitted: message too large]` 替换过大的条目。
- `chat.inject` 直接将助手注释追加到转录并广播到 UI（无智能体运行）。
- 被中止的运行可以继续在 UI 中显示部分助手输出。
- 如果存在已缓冲的部分输出，Gateway 会把被中止的部分助手文本写入转录历史，并用中止元数据标记这些条目。
- 历史记录始终从 Gateway 网关获取（无本地文件监听）。
- 如果 Gateway 网关不可达，WebChat 为只读模式。

## Agent 工具面板

- **Agent > Tools** 通过 `tools.catalog` 获取运行时工具目录，并把每个工具标记为 `core` 或 `plugin:<id>`（可选插件工具还会显示 `optional`）。
- 如果 `tools.catalog` 不可用，面板会退回到内置静态列表。
- 该面板编辑的是每个 Agent 的工具策略。实际运行时访问仍然取决于策略优先级、服务凭据、扩展运行状态，以及当前会话可用的工具目录。
- **Available right now** 是实时会话数据。如果运行时或扩展目录尚未加载，已保存策略仍可能显示工具已允许，而 available-now 区域报告运行时/目录错误。

## 远程使用

- 远程模式通过 SSH/Tailscale 隧道传输 Gateway 网关 WebSocket。
- 你不需要运行单独的 WebChat 服务器。

## 配置参考（WebChat）

完整配置：[配置](/gateway/configuration)

渠道选项：

- 没有专用的 `webchat.*` 块。WebChat 使用下面的 Gateway 网关端点 + 认证设置。

相关的全局选项：

- `gateway.port`、`gateway.bind`：WebSocket 主机/端口。
- `gateway.auth.mode`、`gateway.auth.token`、`gateway.auth.password`：WebSocket 认证。
- `gateway.auth.mode: "trusted-proxy"`：面向浏览器客户端的反向代理认证（见 [Trusted Proxy Auth](/gateway/trusted-proxy-auth)）。
- `gateway.remote.url`、`gateway.remote.token`、`gateway.remote.password`：远程 Gateway 网关目标。
- `sessions.*`：会话存储和主键默认值（如已配置）。
