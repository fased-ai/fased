---
summary: "Fased 设置、运行时、模型、渠道、钱包、任务和排障的简短 FAQ。"
title: "常见问题"
---

# 常见问题

这里放快速答案。正在故障排查时，先看
[Troubleshooting](/help/troubleshooting)、[Diagnostics](/diagnostics/index)
和 [Gateway Troubleshooting](/gateway/troubleshooting)。

<a id="first-60-seconds-if-somethings-broken"></a>

## 出问题时的前 60 秒

先运行：

```bash
fased status
fased status --all
fased gateway probe
fased gateway status
fased doctor
fased logs --follow
```

然后打开对应 owner 页面：

- Agent > Models：模型和 provider。
- Agent > Channels：聊天路由。
- Agent > Services：外部 API。
- Agent > Skills / Tools：运行能力。
- Agent > Memory：memory/QMD/session-memory。
- Agent > Tasks：保存的任务定义和运行记录。
- Wallets、Mining、Fased Network：钱包、挖矿、网络状态。

<a id="im-stuck--whats-the-fastest-way-to-get-unstuck"></a>

## 卡住时最快怎么排查？

1. 运行 `fased status --all`。
2. 打开 **Logs**，按失败子系统过滤。
3. 先看对应 owner 页面，不要直接改 raw config。
4. 运行 `fased doctor`。
5. 渠道问题运行 `fased channels status --probe`。

钱包、挖矿、网络问题：

```bash
fased wallet status --json
fased wallet signer doctor --json
fased mining readiness --wallet mining
fased mining status --json
fased federation status --json
```

## 安装和首次运行

### 推荐安装流程是什么？

使用 [Getting Started](/start/getting-started)：

1. 安装。
2. 运行 onboarding。
3. 打开 Control UI。
4. 配置模型 provider。
5. 发送第一条 chat。
6. 需要时再添加 channels、skills、tasks、wallets、mining 或 Fased Network。

### Onboarding 做什么？

Onboarding 创建基础运行时：state directory、config、workspace、Gateway、
dashboard access，以及可选的钱包/挖矿初始设置。

它不会配置所有模型、渠道、技能、任务、服务、钱包或网络角色。基础运行时正常后，在 Control UI 中继续设置。

### 如何打开 dashboard？

```bash
fased dashboard
fased gateway status
```

<a id="installer-stuck-how-do-i-get-more-feedback"></a>

### 安装程序卡住时怎么拿到更多信息？

```bash
fased status
fased doctor
fased logs --follow
```

再根据平台看 [Install](/install/index)。

## 模型和 Provider

### 需要订阅或 API key 吗？

需要至少一个可用模型路径：API key、OAuth profile、支持的 subscription-backed CLI path，或本地模型 endpoint。

在 **Agent > Models** 配置。

### 推荐什么模型？

给 tool-enabled Agent 使用可靠、强指令跟随模型。小模型或本地模型可以使用，但应减少工具权限并启用 sandbox。

### All models failed 是什么意思？

常见原因：

- 没有对应 provider/profile 凭证；
- model ref 不在允许列表；
- provider quota/account 问题；
- 网络/API 失败；
- fallback model 也没有凭证。

先看 **Agent > Models**，再看 [Model Failover](/concepts/model-failover)。

## Channels 和回复

### Fased 不回复时检查什么？

```bash
fased gateway status
fased channels status --probe
fased pairing list --channel <channel>
fased logs --follow
```

常见原因：

- sender 未 pairing 或 allowlist；
- group 需要 mention；
- channel token/account 未 ready；
- Agent route 错误；
- Gateway auth/URL 不匹配。

## Tasks 和自动化

### Fased 能按计划运行任务吗？

可以。Task 是 Agent/session 拥有的保存定义，run 是历史记录。

```bash
fased task list
fased task run <task-id>
```

### Tasks 不触发怎么办？

检查：

- Agent > Tasks 里有保存的 Task；
- Task 没有暂停；
- Gateway/worker 正在运行；
- model/skill/service preflight 通过；
- delivery target 仍然存在；
- Logs 没有 queue 或 stale lease 错误。

## Wallets、Mining 和 Fased Network

### 应该读哪些文档？

- [Wallet page](/plugins/crypto/wallet-page)
- [Wallet roles and policies](/plugins/crypto/wallet-roles-and-policies)
- [Mining page](/plugins/crypto/mining-page)
- [Mining troubleshooting](/plugins/crypto/mining-troubleshooting)
- [Fased Network](/start/federation)
- [Bond operator](/start/bond-operator-economy)

### 钱包怎么分？

尽量按角色拆分：

- Agent wallet：普通 Agent 钱包动作。
- Mining wallet：SAT mining。
- Vault/bond wallet：bond/operator inventory。

### 挖矿提交为什么低于 target？

实际提交会被 usable miner capital、locked/pending capital、fee reserve、erosion coverage 和 recovery buffer 限制。资本正在清理或 fee headroom 改变时，较低提交可能是正常保护行为。

## Memory、文件和备份

<a id="where-does-fased-store-its-data"></a>

### Fased 的数据存在哪里？

默认 state 在 `~/.fased`。

常见路径：

- `~/.fased/fased.json`
- `~/.fased/credentials/`
- `~/.fased/agents/<agentId>/sessions/`
- `~/.fased/workspace`
- `~/.fased/extensions/`
- `~/.fased/sandboxes/`

<a id="whats-the-recommended-backup-strategy"></a>

### 推荐怎么备份？

私密备份 Agent workspace。不要把 `~/.fased/credentials`、auth profiles、
secrets 和 sessions 放到公开 repo。迁移机器时按需复制 state，并用
`fased status` 验证路径。

## Config 和 Environment

<a id="env-vars-and-env-loading"></a>

## 环境变量和 .env 加载

见 [Environment Variables](/help/environment)。

<a id="how-does-fased-load-environment-variables"></a>

### Fased 如何加载环境变量？

优先级：

1. process environment；
2. 当前目录 `.env`；
3. `~/.fased/.env`；
4. config `env` block；
5. 可选 login-shell import。

Fased 不覆盖已有值。

## Remote Gateway 和 Nodes

### Gateway 应该本地还是远程？

首次设置本地最简单。需要常驻时可以远程/VPS。原始 Gateway 访问应保持私有，使用 Tailscale/SSH 或 trusted proxy。

### Node 会运行 Gateway 吗？

Node 是 paired execution/device surface。Gateway 仍然是控制平面。Node pairing 应视为该设备的 operator 级访问。

## Security

### 是否应该开放 inbound DMs？

使用 pairing 或 allowlists。除非明确知道受众并有严格 tool policy，不要给 tool-enabled Agent 开放 inbound DMs。

### Prompt injection 只影响 public bots 吗？

不是。网页、邮件、文件、日志、图片或粘贴文本都可能携带对抗性指令。使用 access control、tool policy、sandboxing 和现代模型，不要只依赖 prompt 文案。

见 [Gateway Security](/gateway/security)。

## 更多帮助

- [Help hub](/help/index)
- [Troubleshooting](/help/troubleshooting)
- [Diagnostics](/diagnostics/index)
- [Gateway Troubleshooting](/gateway/troubleshooting)
- [Testing](/help/testing)
