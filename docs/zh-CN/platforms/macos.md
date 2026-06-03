---
read_when:
  - 实现 macOS 应用功能
  - 在 macOS 上更改 Gateway 网关生命周期或节点桥接
summary: Fased macOS 配套应用（菜单栏 + Gateway 网关代理）
title: macOS
x-i18n:
  generated_at: "2026-02-03T07:53:14Z"
  model: manual
  provider: manual
  source_hash: a5b1c02e5905e4cbc6c0688149cdb50a5bf7653e641947143e169ad948d1f057
  source_path: platforms/macos.md
  workflow: 15
---

# Fased macOS

macOS 应用是 Fased 的菜单栏配套应用。它拥有 macOS 权限，连接本地或远程 Gateway 网关，并作为节点向智能体暴露 Mac 功能。

## 功能

- 在菜单栏中显示原生通知和状态。
- 拥有 TCC 提示（通知、辅助功能、屏幕录制、麦克风、语音识别、自动化/AppleScript）。
- 运行或连接到 Gateway 网关（本地或远程）。
- 暴露 macOS 专用工具（Canvas、相机、屏幕录制、`system.run`）。
- 在**远程**模式下启动本地节点主机服务，在**本地**模式下停止它。
- 可选地托管 **PeekabooBridge** 用于 UI 自动化。
- 根据请求使用托管 CLI 安装器安装 `fased` CLI；开发者仍可手动使用 repo-backed 的 `./install.sh --no-onboard` 流程。

## 本地 vs 远程模式

- **本地**（默认）：如果存在运行中的本地 Gateway 网关，应用附加到它；否则通过 `fased gateway install` 启用 launchd 服务。
- **远程**：应用通过 SSH/Tailscale 连接到 Gateway 网关，不启动本地 Gateway。
  应用启动本地**节点主机服务**，以便远程 Gateway 网关可以访问此 Mac。
  应用不会将 Gateway 网关作为子进程生成。

## Launchd 控制

应用管理一个标记为 `ai.fased.gateway` 的每用户 LaunchAgent（使用 `--profile`/`FASED_PROFILE` 时为 `ai.fased.<profile>`；旧版 `com.fased.*` 仍会卸载）。

```bash
launchctl kickstart -k gui/$UID/ai.fased.gateway
launchctl bootout gui/$UID/ai.fased.gateway
```

运行命名配置文件时，将标签替换为 `ai.fased.<profile>`。

如果 LaunchAgent 未安装，从应用中启用它或运行 `fased gateway install`。

## 节点功能（mac）

macOS 应用将自身呈现为一个节点。常用命令：

- Canvas：`canvas.present`、`canvas.navigate`、`canvas.eval`、`canvas.snapshot`、`canvas.a2ui.*`
- 相机：`camera.snap`、`camera.clip`
- 屏幕：`screen.record`
- 系统：`system.run`、`system.notify`

节点报告一个 `permissions` 映射，以便智能体可以决定什么是允许的。

节点服务 + 应用 IPC：

- 当无头节点主机服务运行时（远程模式），它作为节点连接到 Gateway 网关 WS。
- `system.run` 在 macOS 应用中执行（UI/TCC 上下文）通过本地 Unix 套接字；提示 + 输出保留在应用内。

协议细节见 [macOS IPC](/platforms/mac/xpc)。

## Exec 审批（system.run）

`system.run` 由应用中的 **Exec 审批**控制。审批策略本地存储在 Mac 上：

```
~/.fased/exec-approvals.json
```

关键行为：

- 允许列表条目匹配解析后的二进制路径。
- shell 控制语法需要明确批准，除非 shell 路径已被允许。
- 环境覆盖会在命令运行前被过滤。
- “Always Allow” 会在可以清晰解析时持久化批准的可执行路径。

安全模型见 [Gateway 安全](/gateway/security)。

## 深度链接

应用为本地操作注册 `fased://` URL 方案。

### `fased://agent`

触发 Gateway 网关 `agent` 请求。

```bash
open 'fased://agent?message=Hello%20from%20deep%20link'
```

没有无人值守 key 时，应用会请求确认并限制请求范围。使用有效 key 时，请求可用于个人自动化。

## 新手引导流程（典型）

1. 安装并启动 **FasedAgent.app**。
2. 完成权限清单（TCC 提示）。
3. 确保**本地**模式处于活动状态且 Gateway 网关正在运行。
4. 打开 `http://localhost:18789` 进入 Control UI。
5. 在 **Agents** 中完成正常设置：为所选 Agent 选择模型 refs、频道账号、Skills、Tools、Memory 和 Tasks。
6. 如果你想要终端访问，安装 CLI。

## 构建和开发工作流程（原生）

- `cd apps/macos && swift build`
- `swift run FasedAgent`（或 Xcode）
- 打包应用：`scripts/package-mac-app.sh`

## 调试 Gateway 网关连接（macOS CLI）

使用调试 CLI 测试与 macOS 应用相同的 Gateway 网关握手和发现路径。

```bash
cd apps/macos
swift run fased-mac connect --json
swift run fased-mac discover --timeout 3000 --json
```

当 Bonjour 或 tailnet 发现结果与应用不一致时，可与 `fased gateway discover --json` 对比。

## 远程连接管道（SSH 隧道）

远程模式使用 SSH 隧道或私有 Gateway URL。设置步骤见 [macOS 远程访问](/platforms/mac/remote)，协议细节见 [Gateway 网关协议](/gateway/protocol)。

## 相关文档

- [Gateway 网关运维手册](/gateway)
- [Gateway 网关（macOS）](/platforms/mac/bundled-gateway)
- [macOS 权限](/platforms/mac/permissions)
- [macOS 远程访问](/platforms/mac/remote)
- [Canvas](/platforms/mac/canvas)
