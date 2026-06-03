---
read_when:
  - 你想添加或删除 channel accounts
  - 你想查看 channel-level status、capability probes 或 provider logs
summary: "管理 channel accounts、login flows、runtime status、probes 和 channel-specific logs。"
title: channels
x-i18n:
  generated_at: "2026-02-03T07:44:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 16ab1642f247bfa96e8e08dfeb1eedfccb148f40d91099f5423f971df2b54e20
  source_path: cli/channels.md
  workflow: 15
---

# `fased channels`

从终端管理 channel accounts 并查看 live runtime state。这是账户设置、login flows、status probes、provider capabilities 和 provider-specific logs 的 CLI surface。

浏览器等价入口是 **Agent > Channels**。这是普通用户为选定 Agent 设置 accounts、QR/login flows、credentials、route assignment 和 delivery targets 的位置。CLI 更适合脚本、headless setup 和 provider-specific diagnostics。

相关文档：

- 渠道指南：[渠道](/channels/index)
- [Channel Routing](/channels/channel-routing)
- [Diagnostics](/diagnostics/index)

## 常用命令

```bash
fased channels list
fased channels status
fased channels capabilities
fased channels capabilities --channel discord --target channel:123
fased channels resolve --channel slack "#general" "@jane"
fased channels logs --channel all
```

## 添加/删除账户

```bash
fased channels add --channel telegram --token <bot-token>
fased channels remove --channel telegram --delete
```

提示：`fased channels add --help` 显示每个渠道的标志（token、app token、signal-cli 路径等）。

Interactive add 也可以提示 account ids/display names，并立即把 configured accounts 绑定到 agents。该流程写入 account-scoped routing bindings；之后也可通过 [`fased agents`](/cli/agents) 管理。

## 登录/登出（交互式）

```bash
fased channels login --channel whatsapp
fased channels logout --channel whatsapp
```

## 故障排除

- 运行 `fased status --deep` 进行全面探测。
- 使用 `fased doctor` 获取引导式修复。
- 如果 channel 显示 configured 但 not live，先检查 Agent > Channels，再看 Logs 和 Advanced > Debug 的 runtime snapshots。

## 能力探测

获取提供商能力提示（可用的 intents/scopes）以及静态功能支持：

```bash
fased channels capabilities
fased channels capabilities --channel discord --target channel:123
```

说明：

- `--channel` 是可选的；省略它可列出所有渠道（包括扩展）。
- `--target` 接受 `channel:<id>` 或原始数字频道 id，仅适用于 Discord。
- 探测是特定于提供商的：Discord intents + 可选的频道权限；Slack bot + user scopes；Telegram bot 标志 + webhook；Signal daemon 版本；MS Teams app token + Graph roles/scopes（在已知处标注）。没有探测功能的渠道报告 `Probe: unavailable`。

## 解析名称为 ID

使用提供商目录将渠道/用户名称解析为 ID：

```bash
fased channels resolve --channel slack "#general" "@jane"
fased channels resolve --channel discord "My Server/#support" "@someone"
fased channels resolve --channel matrix "Project Room"
```

说明：

- 使用 `--kind user|group|auto` 强制指定目标类型。
- 当多个条目共享相同名称时，解析优先选择活跃的匹配项。
