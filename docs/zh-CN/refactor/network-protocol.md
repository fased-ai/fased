---
summary: Fased Network 协议重构：Gateway WebSocket 角色、设备认证、节点传输和审批
title: Fased Network 协议重构
x-i18n:
  source_path: refactor/network-protocol.md
---

# Fased Network 协议重构

这是工程重构说明，不是面向普通用户的 Fased Network 产品指南。公开操作文档见
[Fased Network](/start/federation)、[Nodes](/nodes) 和 [Gateway protocol](/gateway/protocol)。

## 当前代码状态

Fased 现在使用 **Gateway WebSocket** 作为统一控制面和节点传输：

- operator 客户端使用 `role: "operator"`，并带有 `operator.read`、
  `operator.write`、`operator.admin`、`operator.approvals`、`operator.pairing`
  等 scope
- node 客户端使用 `role: "node"`，并声明 `caps`、`commands` 和权限
- WebSocket 客户端会收到 `connect.challenge`，并用设备身份签名，除非启用明确的
  break-glass 配置
- pairing 和 device token 由 gateway device-auth 流程管理
- presence 按稳定 device identity 合并 operator/node 角色
- exec approval 是 gateway 记录，由带 `operator.approvals` scope 的 operator
  客户端处理

旧 TCP JSONL Bridge 现在只是历史文档。新的 node 客户端应使用
[Gateway protocol](/gateway/protocol)。

## 代码来源

- `docs/gateway/protocol.md`
- `docs/nodes/index.md`
- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/server/ws-connection/connect-policy.ts`
- `src/gateway/method-scopes.ts`
- `src/gateway/server-methods/devices.ts`
- `src/gateway/node-invoke-system-run-approval.ts`
- `src/node-host/runner.ts`

## 已完成

- operator 和 node 统一到 WebSocket。
- `operator` / `node` 角色边界明确。
- operator 方法 scope 检查。
- 设备身份、challenge 签名、pairing、按角色分配的 device token 和撤销路径。
- Advanced > Nodes 作为 operator/admin 诊断入口。
- node `system.run` approval 通过 gateway/operator scope 处理。

## 仍需关注

- 远程/公网传输安全仍依赖 gateway 部署模式、Tailscale/private access、trusted proxy
  和 public edge 设计。
- 大媒体 payload 的 node 命令仍需要 backpressure 和大小控制。
- 移动端 UX 和跨设备审批提示还可以继续打磨。
- Bridge 文档只保留历史上下文，不应作为新客户端实现依据。

## 安全规则

- Discovery 不是信任根。
- 设备名称只是人类标签；认证依赖签名设备身份。
- Node capability claim 不能盲信；gateway policy 和 command allowlist 仍然生效。
- `gateway.controlUi.dangerouslyDisableDeviceAuth` 只能作为 break-glass 使用。
