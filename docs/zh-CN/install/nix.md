---
read_when:
  - 你想要可复现、可回滚的安装
  - 你已经在使用 Nix/NixOS/Home Manager
  - 你想要所有内容都固定并以声明式管理
summary: 使用 Nix 以声明式方式运行 Fased
title: Nix
x-i18n:
  generated_at: "2026-02-03T07:49:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f1452194cfdd74613b5b3ab90b0d506eaea2d16b147497987710d6ad658312ba
  source_path: install/nix.md
  workflow: 15
---

# Nix 安装

目前没有单独公开的 `nix-fased` 仓库。本页记录的是：如果你已经在使用
Nix、NixOS 或 Home Manager，如何基于主仓库
[`fased-ai/agent`](https://github.com/fased-ai/agent)
对 Fased 做可复现封装。

## 快速开始

如果你想走 Nix 路线，建议按这个顺序做：

```text
1. 安装 Determinate Nix 或你自己的 Nix 发行版
2. 克隆主仓库：github.com/fased-ai/agent
3. 在 flake / devShell 中固定 Node、pnpm、Swift（如果需要 macOS app）
4. 将 FASED_STATE_DIR 和 FASED_CONFIG_PATH 指向可写位置
5. 通过 `./install.sh --no-onboard` 或你自己的封装脚本安装 CLI
6. 验证 launchd / systemd / CLI 是否按你的 Nix 配置正常工作
```

如果你维护自己的 flake 或 Home Manager 模块，这一页就是你要对齐的运行时约束说明。

## 你将获得

- Gateway 网关 + macOS 应用 + 工具（whisper、spotify、cameras）— 全部固定版本
- 重启后仍能运行的 Launchd 服务
- 带有声明式配置的插件系统
- 即时回滚：`home-manager switch --rollback`

---

## Nix 模式运行时行为

当设置 `FASED_NIX_MODE=1` 时：

Fased 支持 **Nix 模式**，使配置确定性并禁用自动安装流程。
通过导出以下环境变量启用：

```bash
FASED_NIX_MODE=1
```

在 macOS 上，GUI 应用不会自动继承 shell 环境变量。你也可以通过 defaults 启用 Nix 模式：

```bash
defaults write ai.fased.mac fased.nixMode -bool true
```

### 配置 + 状态路径

Fased 从 `FASED_CONFIG_PATH` 读取 JSON5 配置，并将可变数据存储在 `FASED_STATE_DIR` 中。

- `FASED_STATE_DIR`（默认：`~/.fased`）
- `FASED_CONFIG_PATH`（默认：`$FASED_STATE_DIR/fased.json`）

在 Nix 下运行时，将这些显式设置为 Nix 管理的位置，以便运行时状态和配置不会进入不可变存储。

### Nix 模式下的运行时行为

- 自动安装和自我修改流程被禁用
- 缺失的依赖会显示 Nix 特定的修复消息
- 存在时 UI 会显示只读 Nix 模式横幅

## 打包注意事项（macOS）

macOS 打包流程期望在以下位置有一个稳定的 Info.plist 模板：

```
apps/macos/Sources/FasedAgent/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/fased-ai/agent/blob/main/scripts/package-mac-app.sh) 将此模板复制到应用包中并修补动态字段（bundle ID、版本/构建号、Git SHA、Sparkle 密钥）。这使 plist 对于 SwiftPM 打包和 Nix 构建保持确定性（它们不依赖完整的 Xcode 工具链）。

## 相关内容

- [主仓库](https://github.com/fased-ai/agent)
- [向导](/start/wizard) — 非 Nix CLI 设置
- [Docker](/install/docker) — 容器化设置
