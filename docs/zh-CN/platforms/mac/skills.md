---
read_when:
  - 更新 macOS Skills 设置 UI
  - 更改 Skills 门控或安装行为
summary: macOS Skills 设置 UI 和基于 Gateway 网关的状态
title: Skills
x-i18n:
  generated_at: "2026-02-03T10:08:09Z"
  model: manual
  provider: manual
  source_hash: ecd5286bbe49eed89319686c4f7d6da55ef7b0d3952656ba98ef5e769f3fbf79
  source_path: platforms/mac/skills.md
  workflow: 15
---

# Skills（macOS）

macOS 应用通过 Gateway 网关展示 Fased Skills；它不会自己解析 `SKILL.md` 文件。完整事实来源是浏览器 Control UI 中所选 Agent 的 **Agent > Skills**。macOS 设置面板只是一个紧凑的操作视图，用于查看状态、安装依赖、保存环境值和切换启用状态。

## 数据来源

- `skills.status`（Gateway 网关）返回所有 Skills 以及资格和缺失的要求。
- 要求来源于每个 `SKILL.md` 中的 `metadata.fased.requires`。
- Agent allowlist 是按 Agent 保存的。把 Skill 安装到 Library 不会自动授予某个 Agent 使用权限。

## 安装操作

- `metadata.fased.install` 定义安装选项（brew/node/go/uv）。
- 应用在当前连接的 Gateway 上调用 `skills.install`。远程模式下，**Install on Gateway** 在远程 Gateway 主机上运行。**Install on This Mac** 会切换到本地模式，并对这台 Mac 运行同一个 gateway-backed 安装器。
- 只有当所需二进制/config 对 Gateway 运行时可见时，安装才算 ready。包管理器命令退出 0 并不等于 Skill 可用。
- Homebrew 是可选的。在 Linux/WSL 上，Skill 应优先提供 npm/go/uv/apt 风格说明，或显示手动设置提示。

## 配置和授权

- Skill-local 配置位于 `skills.entries.<skillKey>`。
- 例如频道 token 这类 root config 要求，应显示为写入真实 config path 的 typed field。
- `skills.update` 更新 `enabled`、`apiKey` 和 `env`。
- 安装永远不会授予钱包或挖矿权限。Wallet-capable Skill 需要在 **Wallets → Access / Skill Grants** 中单独审核。

## 远程模式

- 安装 + 配置更新发生在 Gateway 网关主机上（不是本地 Mac）。
- 如果 Mac 只是远程控制器，依赖必须位于远程主机 PATH，而不是本地 Mac PATH。
