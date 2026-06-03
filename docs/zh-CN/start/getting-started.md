---
read_when:
  - 从零开始首次设置
  - 你想要从安装 → 新手引导 → 第一条消息的最快路径
summary: 新手指南：安装 Fased，并在几分钟内完成第一次浏览器聊天。
title: 入门指南
x-i18n:
  generated_at: "2026-02-03T07:54:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 78cfa02eb2e4ea1a83e18edd99d142dbae707ec063e8d74c9a54f94581aa067f
  source_path: start/getting-started.md
  workflow: 15
---

# 入门指南

目标：尽快从**零**到**第一个可用聊天**（使用合理的默认值）。

<Warning>
如果你准备使用钱包、SAT Mining、Fased Network、运营者经济或后续交易/新闻功能，请先阅读仓库风险边界：
[`DISCLAIMER.md`](https://github.com/fased-ai/fased/blob/main/DISCLAIMER.md)。
</Warning>

<Info>
最快聊天：打开 Control UI（无需先配置渠道）。运行 `fased dashboard` 并在浏览器中聊天，或在 Gateway 主机上打开 `http://localhost:18789/`。文档：[Dashboard](/web/dashboard) 和 [Control UI](/web/control-ui)。
</Info>

推荐路径：使用 **CLI 新手引导向导**（`fased onboard`）。它设置：

- 模型/认证（推荐 OAuth）
- Gateway 网关设置
- 工作区引导
- 可选钱包和 Mining 钱包角色
- 托管/远程访问安全选项
- 可选的后台服务

如果你想要更深入的参考页面，跳转到：[向导](/start/wizard)、[设置](/start/setup)、[配对](/channels/pairing)、[安全](/gateway/security)。

## 0) 前置条件

- Node 24 推荐，或带内置 `node:sqlite` 模块的 Node 22.14+
- `pnpm`（可选；如果从源代码构建则推荐）
- 可选网页搜索：在 Control UI 中打开 **Agent > Services**，配置 web/search 提供商和 API key。CLI 也支持 `fased configure --section web`。

macOS：如果你计划构建应用，安装 Xcode / CLT。仅用于 CLI + Gateway 网关的话，Node 就足够了。
Windows：使用 **WSL2**（推荐 Ubuntu）。强烈推荐 WSL2；原生 Windows 未经测试，问题更多，工具兼容性更差。先安装 WSL2，然后在 WSL 内运行 Linux 步骤。参见 [Windows (WSL2)](/platforms/windows)。

## 1) 安装 CLI（推荐）

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
```

安装程序选项（安装方法、非交互式、从 GitHub）：[安装](/install)。

Windows：请先使用 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)，然后在 Ubuntu 里运行同样的仓库安装命令。

## 2) 运行新手引导向导（并安装服务）

```bash
fased onboard --install-daemon
```

`./install.sh` 默认会运行新手引导。只有在你用了
`./install.sh --no-onboard`、新手引导被中断，或需要重新配置守护进程时，才需要单独运行这条命令。

你将选择：

- **本地 vs 托管** Gateway
- **认证**：OpenAI/OpenAI Codex、Anthropic 或其他模型提供商；可以用 OAuth 或 API key。
- **钱包**（可选）：Agent、Mining、Vault 角色分离；Fased Network bond 使用 Vault 钱包。
- **渠道**（可选）：Telegram、Discord、WhatsApp 等可以在向导或稍后在 **Agent > Channels** 完成。
- **守护进程**：后台安装（launchd/systemd；WSL2 使用 systemd）
  - **运行时**：Node（推荐；WhatsApp/Telegram 必需）。**不推荐** Bun。
- **Gateway 网关令牌**：向导默认生成一个（即使在 loopback 上）并存储在 `gateway.auth.token`。

向导文档：[向导](/start/wizard)

### 凭证：存储位置（重要）

- **推荐的 Anthropic 路径：**设置 API 密钥（向导可以为服务使用存储它）。如果你想复用 Claude Code 凭证，也支持 `claude setup-token`。

- OAuth 凭证（旧版导入）：`~/.fased/credentials/oauth.json`
- 认证配置文件（OAuth + API 密钥）：`~/.fased/agents/<agentId>/agent/auth-profiles.json`

无头/服务器提示：先在普通机器上完成 OAuth，然后将 `oauth.json` 复制到 Gateway 网关主机。

## 3) 启动 Gateway 网关

如果你在新手引导期间安装了服务，Gateway 网关应该已经在运行：

```bash
fased gateway status
```

手动运行（前台）：

```bash
fased gateway --port 18789 --verbose
```

Dashboard（local loopback）：`http://localhost:18789/`
如果配置了令牌，将其粘贴到 Control UI 设置中（存储为 `connect.params.auth.token`）。

⚠️ **Bun 警告（WhatsApp + Telegram）：**Bun 与这些渠道存在已知问题。如果你使用 WhatsApp 或 Telegram，请使用 **Node** 运行 Gateway 网关。

## 3.5) 快速验证（2 分钟）

```bash
fased status
fased health
fased security audit --deep
```

## 4) 打开 Control UI 并完成 Agent 设置

```bash
fased dashboard
```

继续在浏览器中设置选定 Agent：

- **Agent > Models**：添加提供商 API key 或登录，然后选择 Primary/Fallback/Task 模型。
- **Agent > Skills**：创建、审查、安装、配置、编辑并允许该 Agent 使用 Skills。
- **Agent > Services**：连接 Gmail、Calendar、GitHub、web/search、browser/media 或自定义 API。
- **Agent > Channels**：连接聊天应用并路由到该 Agent。
- **Agent > Memory**：启用 session-memory，并查看该 Agent 的 archive/QMD 状态。
- **Agent > Tasks**：为该 Agent 创建定时或事件触发任务。

当 **Agent > Models** 显示可用模型后，打开 **Chat**，选择同一个 Agent，发送：

```text
Reply with one sentence: Fased is ready.
```

如果失败，按顺序检查：

1. **Agent > Models**：提供商认证或模型选择
2. **Logs**：提供商/运行时错误详情
3. **Advanced > Debug**：原始诊断和修复工具

## 5) 可选：连接消息渠道

### WhatsApp（QR 登录）

```bash
fased channels login
```

通过 WhatsApp → 设置 → 链接设备扫描。

WhatsApp 文档：[WhatsApp](/channels/whatsapp)

### Telegram / Discord / 其他

向导可以为你写入令牌/配置。如果你更喜欢手动配置，从这里开始：

- Telegram：[Telegram](/channels/telegram)
- Discord：[Discord](/channels/discord)
- Mattermost（插件）：[Mattermost](/channels/mattermost)

**Telegram 私信提示：**你的第一条私信会返回配对码。批准它（见下一步），否则机器人不会响应。

## 6) 私信安全（配对审批）

默认姿态：未知私信会获得一个短代码，消息在批准之前不会被处理。如果你的第一条私信没有收到回复，批准配对：

```bash
fased pairing list whatsapp
fased pairing approve whatsapp <code>
```

配对文档：[配对](/channels/pairing)

## 从源代码（开发）

如果你正在开发 Fased 本身，从源代码运行：

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
pnpm install
pnpm ui:build # 首次运行时自动安装 UI 依赖
pnpm build
./install.sh --no-onboard
fased onboard --install-daemon
```

如果 `fased` 命令缺失，请先在仓库目录运行 `./install.sh --no-onboard`。`pnpm build` 也会打包 A2UI 资源；如果你只需要运行那个步骤，使用 `pnpm canvas:a2ui:bundle`。

Gateway 网关（从此仓库）：

```bash
node fased.mjs gateway --port 18789 --verbose
```

## 7) 验证端到端

在新终端中，发送测试消息：

```bash
fased message send --target +15555550123 --message "Hello from Fased"
```

如果 `fased health` 显示"未配置认证"，回到向导设置 OAuth/密钥认证——没有它智能体将无法响应。

提示：`fased status --all` 是最佳的可粘贴、只读调试报告。
健康探测：`fased health`（或 `fased status --deep`）向运行中的 Gateway 网关请求健康快照。

## 下一步（可选，但很棒）

- macOS 菜单栏应用 + 语音唤醒：[macOS 应用](/platforms/macos)
- iOS/Android 节点（Canvas/相机/语音）：[节点](/nodes)
- 远程访问（SSH 隧道 / Tailscale Serve）：[远程访问](/gateway/remote) 和 [Tailscale](/gateway/tailscale)
- 常开 / VPN 设置：[远程访问](/gateway/remote)、[Hetzner](/install/hetzner)、[macOS 远程](/platforms/mac/remote)
- 钱包、Fased Network 和 SAT Mining：[Mining](/plugins/crypto/mining-page)
