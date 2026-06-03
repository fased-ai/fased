---
read_when:
  - 更改仪表板认证或暴露模式
summary: Gateway 网关仪表板（控制 UI）访问和认证
title: 仪表板
x-i18n:
  generated_at: "2026-02-03T10:13:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e6876d50e17d3dd741471ed78bef6ac175b2fdbdc1c45dd52d9d2bd013e17f31
  source_path: web/dashboard.md
  workflow: 15
---

# 仪表板（控制 UI）

Dashboard 是浏览器 Control UI 的概览页。默认入口 `/` 会路由到 `/dash`
（也可以通过 `gateway.controlUi.basePath` 设置前缀）。

快速打开（本地 Gateway 网关）：

- http://localhost:18789/（推荐）
- http://127.0.0.1:18789/（如果你明确需要数字 loopback）

Dashboard 是紧凑小组件板，不是设置向导。

它用于：

- 查看 Agent、任务、会话、usage、wallet、mining 和 Fased Network 的高层状态
- 从顶部栏添加/移除 widgets
- 桌面端拖动 widget header 并调整高度
- 在 widget 内容过多时只在 widget 内部纵向滚动
- 避免把 gateway access、runtime clients、raw config、Debug、Nodes 放回普通 Dashboard

详细设置属于焦点页面：

- **Agents**：models、skills、channels、services、tools、memory、tasks、sessions
- **Wallets**：钱包角色、余额、审批、passkey 和安全策略
- **Mining**：SAT mining 控制、capital、live cycle、history、recovery
- **Usage**：按 provider/model/Agent/session/task/source 的本地模型 usage 历史
- **Advanced**：Config、Debug、Nodes 运维诊断

关键参考：

- [控制 UI](/web/control-ui) 了解使用方法和 UI 功能。
- [Tailscale](/gateway/tailscale) 了解 Serve/Funnel 自动化。
- [Web 界面](/web) 了解绑定模式和安全注意事项。

认证通过 `connect.params.auth`（token 或密码）在 WebSocket 握手时强制执行。
参见 [Gateway 网关配置](/gateway/configuration) 中的 `gateway.auth`。

安全注意事项：控制 UI 是一个**管理界面**（聊天、配置、执行审批）。
不要公开暴露它。UI 在首次加载后将 token 存储在 `localStorage` 中。
优先使用 localhost、Tailscale Serve 或 SSH 隧道。

## Dashboard widgets

默认 widgets 保持高信号：

- **Agents**：所有 Agents、tasks、sessions。
- **Usage**：7 天 token usage 历史。
- **Wallets**：按 Agent、Mining、Vault 钱包角色聚合的 SOL。
- **Mining**：mining 状态、mining 钱包余额、locked capital、7 天 SAT history。
- **Fased Network**：节点身份和 operator 状态摘要。

Gateway access 和 runtime-client/presence 细节不是普通用户 Dashboard widgets。需要底层诊断时使用顶部 health dot、Advanced > Debug 或 Advanced > Nodes。

## 快速路径（推荐）

- 新手引导后，CLI 会打开 Dashboard 并打印链接。
- 随时重新打开：`fased dashboard`（复制链接，如果可能则打开浏览器，如果是无头环境则显示 SSH 提示）。
- 如果 UI 提示认证，粘贴 `gateway.auth.token`（或 `FASED_GATEWAY_TOKEN`）。

## Token 基础（本地 vs 远程）

- **Localhost**：打开 `http://localhost:18789/`。
- **Token 来源**：`gateway.auth.token`（或 `FASED_GATEWAY_TOKEN`）；UI 在首次加载后存储它。
- **非 localhost**：使用 Tailscale Serve（如果 `gateway.auth.allowTailscale: true` 则无需 token）、带 token 的 tailnet 绑定，或 SSH 隧道。参见 [Web 界面](/web)。

## 如果你看到"unauthorized" / 1008

- 运行 `fased dashboard` 获取新的带 token 链接。
- 确保 Gateway 网关可达（本地：`fased status`；远程：SSH 隧道 `ssh -N -L 18789:127.0.0.1:18789 user@host` 然后打开 `http://127.0.0.1:18789/?token=...`）。
- 在仪表板设置中，粘贴你在 `gateway.auth.token`（或 `FASED_GATEWAY_TOKEN`）中配置的相同 token。
