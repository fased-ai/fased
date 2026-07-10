---
read_when:
  - 更新 Fased
  - 更新后出现问题
summary: 通过 `fased update` 安全更新本地或托管的 Fased
title: 更新
x-i18n:
  generated_at: "2026-04-21T00:00:00Z"
  model: manual
  provider: codex
  source_path: install/updating.md
---

# 更新

Fased 还在快速演进。把更新当成基础设施变更：更新 → 检查 → 重启 → 验证。

<Note>
`fased onboard --install-daemon` 是初始设置和服务安装流程，不是主要的版本升级命令。
正常版本更新请使用 `fased update`。控制界面目前只显示更新状态；重新运行
`./install.sh` 用于修复或重新安装。
</Note>

## 推荐：更新仓库后重新运行安装器

```bash
cd ~/fased
git pull --rebase
./install.sh
```

说明：

- 如果你不想再次进入新手引导，加上 `--no-onboard`
- 预发布版本不会通过安装器写入 SAT mainnet ids；mainnet proof 发布后，在 Mining 页面使用 Sync
- 如果你是源码运行，希望直接使用当前 checkout：

```bash
cd ~/fased
git pull --rebase
./install.sh --no-onboard
```

当前公开文档不再把 npm 全局安装当作主要升级路径。

## `fased update`

对于 git checkout，首选：

```bash
fased update
```

它会：

- 要求工作树干净
- 切换或确认当前渠道
- 拉取并 rebase 上游
- 安装依赖、构建、构建 Control UI
- 运行 `fased doctor`
- 默认重启 Gateway

如果你不想立刻重启：

```bash
fased update --no-restart
```

## 控制界面更新状态

控制界面的 **Advanced > Debug > Update Status** 会显示当前版本、更新渠道、
安装来源和可用更新。实际更新仍从终端运行：

```bash
fased update status
fased update
```

## 手动源码更新

```bash
cd ~/fased
git pull --rebase
pnpm install
pnpm build:app
fased doctor
fased gateway restart
fased health
```

## 更新前建议备份

- 配置：`~/.fased/fased.json`
- 凭证：`~/.fased/credentials/`
- 工作区：`~/.fased/workspace`

## 每次更新后都应该做

```bash
fased doctor
fased gateway restart
fased health
```

## 回滚

如果回滚到某个已知良好的提交：

```bash
cd ~/fased
git fetch origin
git checkout "<commit>"
pnpm install
pnpm build:app
fased gateway restart
```

## 相关页面

- [安装](/install)
- [安装器内部机制](/install/installer)
- [CLI 更新命令](/cli/update)
