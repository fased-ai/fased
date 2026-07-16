---
read_when:
  - 你想从机器上移除 Fased
  - 卸载后 Gateway 网关服务仍在运行
summary: 完全卸载 Fased（CLI、服务、状态、工作区）
title: 卸载
x-i18n:
  generated_at: "2026-02-03T07:50:10Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6673a755c5e1f90a807dd8ac92a774cff6d1bc97d125c75e8bf72a40e952a777
  source_path: install/uninstall.md
  workflow: 15
---

# 卸载

两种方式：

- 如果 `fased` 仍已安装，使用**简单方式**。
- 如果 CLI 已删除但服务仍在运行，使用**手动服务移除**。

## 简单方式（CLI 仍已安装）

推荐：使用内置卸载程序：

```bash
fased uninstall
```

非交互式：

```bash
fased uninstall --all --yes --non-interactive
```

手动步骤（效果相同）：

1. 停止 Gateway 网关服务：

```bash
fased gateway stop
```

2. 卸载 Gateway 网关服务（launchd/systemd/schtasks）：

```bash
fased gateway uninstall
```

3. 删除状态 + 配置：

```bash
rm -rf "${FASED_STATE_DIR:-$HOME/.fased}"
```

如果你将 `FASED_CONFIG_PATH` 设置为状态目录外的自定义位置，也请删除该文件。

4. 删除你的工作区（可选，移除智能体文件）：

```bash
rm -rf ~/.fased/workspace
```

5. 如果你是通过仓库 checkout 安装的，请删除本地仓库目录：

```bash
rm -rf /path/to/fased-agent
```

6. 如果你安装了 macOS 应用：

```bash
rm -rf /Applications/FasedAgent.app
```

注意事项：

- 如果你使用了配置文件（`--profile` / `FASED_PROFILE`），对每个状态目录重复步骤 3（默认为 `~/.fased-<profile>`）。
- 在远程模式下，状态目录位于 **Gateway 网关主机**上，因此也需要在那里运行步骤 1-4。

## 手动服务移除（CLI 未安装）

如果 Gateway 网关服务持续运行但 `fased` 缺失，请使用此方法。

### macOS（launchd）

默认标签是 `ai.fased.gateway`（或 `ai.fased.<profile>`；旧版 `com.fased.*` 可能仍然存在）：

```bash
launchctl bootout gui/$UID/ai.fased.gateway
rm -f ~/Library/LaunchAgents/ai.fased.gateway.plist
```

如果你使用了配置文件，请将标签和 plist 名称替换为 `ai.fased.<profile>`。如果存在任何旧版 `com.fased.*` plist，请将其移除。

### Linux（systemd 用户单元）

默认单元名称是 `fased-gateway.service`（或 `fased-gateway-<profile>.service`）：

```bash
systemctl --user disable --now fased-gateway.service
rm -f ~/.config/systemd/user/fased-gateway.service
systemctl --user daemon-reload
```

### 旧版原生 Windows 安装（计划任务）

当前公开的 Windows 安装路径在 WSL2 内运行，应使用上面的 Linux/systemd 卸载步骤。以下命令仅用于清理过去创建的原生 Windows 安装。

默认任务名称是 `FasedAgent Gateway`（或 `FasedAgent Gateway (<profile>)`）。
任务脚本位于你的状态目录下。

```powershell
schtasks /Delete /F /TN "FasedAgent Gateway"
Remove-Item -Force "$env:USERPROFILE\.fased\gateway.cmd"
```

如果你使用了配置文件，请删除匹配的任务名称和 `~\.fased-<profile>\gateway.cmd`。

## 普通安装 vs 源码检出

### 普通安装（仓库安装 / 直接包管理器安装）

当前公开文档推荐的路径是：

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
```

如果你后来又手动做过全局安装，再额外执行 `npm rm -g fased` 或 `pnpm remove -g fased` 清理全局 CLI。

### 源码检出（git clone）

如果你从仓库检出运行（`git clone` + `fased ...` / `bun run fased ...`）：

1. 在删除仓库**之前**卸载 Gateway 网关服务（使用上面的简单方式或手动服务移除）。
2. 删除仓库目录。
3. 按上述方式移除状态 + 工作区。
