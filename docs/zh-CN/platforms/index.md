---
read_when:
  - 查找操作系统支持或安装路径时
  - 决定在哪里运行 Gateway 网关时
summary: 平台支持概述（Gateway 网关 + 配套应用）
title: 平台
x-i18n:
  generated_at: "2026-02-03T07:52:07Z"
  model: manual
  provider: manual
  source_hash: 254852a5ed1996982a52eed4a72659477609e08d340c625d24ef6d99c21eece6
  source_path: platforms/index.md
  workflow: 15
---

# 平台

Fased 核心使用 TypeScript 编写。**Node 是推荐的运行时**。
不推荐 Bun 用于 Gateway 网关（WhatsApp/Telegram 存在 bug）。

配套应用适用于 macOS（菜单栏应用）和移动节点（iOS/Android）。Windows 和
Linux 配套应用已在计划中，但 Gateway 网关目前已完全支持。
Windows 原生配套应用也在计划中；Fased CLI、Gateway 网关和钱包签名器必须在 WSL2 Ubuntu 内运行。

## 当前 UI 模型

- Gateway 在 `http://localhost:18789` 提供浏览器 Control UI。
- 普通设置是 Agent-first：打开 **Agents**，选择 Agent，然后使用
  **Models**、**Channels**、**Skills**、**Tools**、**Memory**、**Services**
  和 **Tasks** 标签。
- **Dashboard** 是可自定义概览板。
- **Chat** 是选定 Agent/session 的浏览器聊天界面。
- **Advanced** 包含原始 Config、Debug 和 Nodes。移动/桌面配套设备在
  **Advanced > Nodes** 中查看。

## 选择你的操作系统

- macOS：[macOS](/platforms/macos)
- iOS：[iOS](/platforms/ios)
- Android：[Android](/platforms/android)
- Windows：[Windows](/platforms/windows)
- Linux：[Linux](/platforms/linux)

## VPS 和托管

- VPS 中心：[VPS 托管](/install/vps)
- Hetzner（受维护的非 Docker Hosting）：[Hetzner](/install/hetzner)
- GCP（Compute Engine）：[GCP](/install/gcp)
- Fly.io（不支持的历史归档）：[Fly.io](/install/fly)

完整 Docker Gateway 只支持本地电脑。VPS 使用 `install.sh --hosting`；不存在
`install.sh --hosting-docker`。

## 常用链接

- 安装指南：[入门指南](/start/getting-started)
- Gateway 网关运行手册：[Gateway 网关](/gateway)
- Gateway 网关配置：[配置](/gateway/configuration)
- 服务状态：`fased gateway status`

## Gateway 网关服务安装（CLI）

使用以下任一方式（均支持）：

- 向导（推荐）：`fased onboard --install-daemon`
- 直接安装：`fased gateway install`
- 配置流程：`fased configure` → 选择 **Gateway service**
- 修复/迁移：`fased doctor`（提供安装或修复服务）

服务目标取决于操作系统：

- macOS：LaunchAgent（`ai.fased.gateway` 或 `ai.fased.<profile>`；旧版 `com.fased.*`）
- Linux/WSL2：systemd 用户服务（`fased-gateway[-<profile>].service`）
