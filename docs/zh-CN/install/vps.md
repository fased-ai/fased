---
read_when:
  - 你想在云端运行 Gateway 网关
  - 你需要 VPS/托管指南的快速索引
summary: Fased 的 VPS 托管中心（Oracle/Fly/Hetzner/GCP 与通用 VPS 指南）
title: VPS 托管
x-i18n:
  generated_at: "2026-02-03T10:12:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 7749b479b333aa5541e7ad8b0ff84e9f8f6bd10d7188285121975cb893acc037
  source_path: install/vps.md
  workflow: 15
---

# VPS 托管

本中心链接到支持的 VPS/托管指南，并在高层次上解释云部署的工作原理。

## 选择提供商

- **Oracle Cloud**：[Oracle](/platforms/oracle)
- **Fly.io**：[Fly.io](/install/fly)
- **Hetzner（Docker）**：[Hetzner](/install/hetzner)
- **GCP（Compute Engine）**：[GCP](/install/gcp)

Fased 文档只列出由本仓库文件支持的托管安装方式，例如 `fly.toml`、`render.yaml`、Docker
或仓库安装器。外部托管预设不在这里列出，因为无法从本仓库验证或维护。

## 云设置的工作原理

- **runtime 和 Gateway 运行在 VPS 上**，并拥有状态 + 工作区。
- 将 VPS 视为数据源，并备份状态 + 工作区。
- onboarding 前先创建或登录 **Tailscale**。
- 托管路径使用 `fased onboard --host-profile hosting`。
- 默认把 Gateway 留在 loopback，通过 Tailscale SSH 或私有隧道访问。
- 不要为了打开 dashboard 或 WebSocket 而公开原始 Gateway 端口。
- 如果绑定到 `lan`/`tailnet`，需要 `gateway.auth.token` 或 `gateway.auth.password`。

远程访问：[Gateway 网关远程访问](/gateway/remote)
平台中心：[平台](/platforms)

## 在 VPS 上使用节点

你可以将 Gateway 网关保持在云端，并在本地设备（Mac/iOS/Android/无头）上配对**节点**。节点提供本地屏幕/摄像头/canvas 和 `system.run` 功能，而 Gateway 网关保持在云端。

文档：[节点](/nodes)，[节点 CLI](/cli/nodes)
