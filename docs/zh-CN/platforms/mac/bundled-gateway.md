---
read_when:
  - 打包 FasedAgent.app
  - 调试 macOS Gateway 网关 launchd 服务
  - 为 macOS 安装 Gateway 网关 CLI
summary: macOS 上的 Gateway 网关运行时（外部 launchd 服务）
title: macOS 上的 Gateway 网关
x-i18n:
  generated_at: "2026-02-03T07:52:30Z"
  model: manual
  provider: manual
  source_hash: 4a3e963d13060b123538005439213e786e76127b370a6c834d85a369e4626fe5
  source_path: platforms/mac/bundled-gateway.md
  workflow: 15
---

# macOS 上的 Gateway 网关（外部 launchd）

FasedAgent.app 不再捆绑 Node/Bun 或 Gateway 网关运行时。macOS 应用期望有一个**外部**的 `fased` CLI 安装，不会将 Gateway 网关作为子进程启动，而是管理一个每用户的 launchd 服务来保持 Gateway 网关运行（或者如果已有本地 Gateway 网关正在运行，则连接到现有的）。

## 安装 CLI（本地模式必需）

你需要在 Mac 上安装 Node 24 推荐版，或带 `node:sqlite` 的 Node 22.14+。
然后通过主仓库 checkout 安装 `fased`：

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --no-onboard
```

macOS 应用的**安装 CLI**按钮使用托管的 Fased CLI 安装器，并安装到
`~/.fased`。如果你在测试本地 checkout，或不想使用托管安装器，请使用上面的手动 repo-backed 流程。

## Launchd（Gateway 网关作为 LaunchAgent）

标签：

- `ai.fased.gateway`（或 `ai.fased.<profile>`；旧版 `com.fased.*` 可能仍然存在）

Plist 位置（每用户）：

- `~/Library/LaunchAgents/ai.fased.gateway.plist`
  （或 `~/Library/LaunchAgents/ai.fased.<profile>.plist`）

管理者：

- macOS 应用在本地模式下拥有 LaunchAgent 的安装/更新权限。
- CLI 也可以安装它：`fased gateway install`。

行为：

- "FasedAgent Active" 启用/禁用 LaunchAgent。
- 应用退出**不会**停止 Gateway 网关（launchd 保持其存活）。
- 如果 Gateway 网关已经在配置的端口上运行，应用会连接到它而不是启动新的。

日志：

- launchd stdout/err：`/tmp/fased/fased-gateway.log`

## 版本兼容性

macOS 应用会检查 Gateway 网关版本与其自身版本是否匹配。如果不兼容，请更新全局 CLI 以匹配应用版本。

## 冒烟测试

```bash
fased --version

FASED_SKIP_CHANNELS=1 \
FASED_SKIP_CANVAS_HOST=1 \
fased gateway --port 18999 --bind loopback
```

然后：

```bash
fased gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
