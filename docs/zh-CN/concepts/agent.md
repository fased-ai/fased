---
read_when:
  - 更改智能体运行时、工作区引导或会话行为时
summary: 智能体运行时、Agent 工作台标签页、工作区契约和会话引导。
title: 智能体运行时
x-i18n:
  generated_at: "2026-02-03T10:04:53Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 04b4e0bc6345d2afd9a93186e5d7a02a393ec97da2244e531703cb6a1c182325
  source_path: concepts/agent.md
  workflow: 15
---

# 智能体运行时

Fased 运行一个 Gateway 进程，可以托管多个持久 Agent。嵌入式模型/工具运行时源自 `pi-mono`，但 Agent 注册表、会话管理、路由、工作区契约、工具策略、渠道投递、任务和钱包边界都由 Fased 自己负责。

## Agent 工作台

普通设置从 **Agents** 页面开始，然后选择一个 Agent。选定 Agent 拥有这些面向用户的设置标签页：

| 标签页       | 负责内容                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Setup        | identity、workspace、memory、skills、models、channels、tools、services、tasks、sessions、usage 和 extension health 的摘要卡片 |
| Models       | 提供商登录/API key，以及该 Agent 的 primary、fallback、task 模型引用                                                          |
| Channels     | 聊天账号设置、QR/login、路由、DM/group policy，以及投递到该 Agent                                                             |
| Skills       | Skill library、插件目录搜索/审查/安装、创建/编辑/配置、依赖安装，以及该 Agent 的 skill access policy                          |
| Tools        | 服务/扩展暴露工具后，每 Agent 的 allow/deny                                                                                   |
| Memory       | session archive 开关、workspace memory roots、backend、QMD 状态和每 Agent 验证                                                |
| Sessions     | 该 Agent 的会话、token/session metadata、关联任务和受保护的删除/恢复操作                                                      |
| Services     | 选定 Agent 上下文中的 connector setup/status；某些服务凭证仍是全局的                                                          |
| Tasks        | 该 Agent 的定时/事件触发工作，以及 webhook、channel、media、wallet、Marketplace、Mining 等来源的共享运行历史                  |
| Coordination | 多 Agent task evidence、选定 Agent review、retry-with-evidence 控制                                                           |
| Files        | `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md` 等用户拥有的工作区 bootstrap 文件                                |

Debug、Advanced Config、Extensions、Logs、Nodes、Usage、Wallets、Mining、Fased Network 和 Marketplace 仍然存在，用于运行时、安全、经济和诊断。普通 Agent 设置不应要求编辑原始配置。

**Agent > Tasks** 是审计和工作面，不是所有领域的控制面。Wallet、Marketplace 和 Mining 行在这里是只读镜像：可以打开来源页面或启动 review workflow，但签名、订单/争议、start/stop、commit/reveal、claim 和 recovery 仍必须在 Wallets、Marketplace 或 Mining 页面完成；gateway 会拒绝从 Tasks 直接 retry/resume/control 这些来源记录。

## 工作区（必需）

每个 Agent 都有一个工作区目录。默认 Agent 使用 `agents.defaults.workspace`；其他 Agent 可以通过 `agents.list[].workspace` 覆盖。当前 Agent 工作区是文件工具和工作区上下文的工作目录。

建议：使用 `fased setup` 在缺失时创建 `~/.fased/fased.json` 并初始化工作区文件。

完整工作区布局 + 备份指南：[智能体工作区](/concepts/agent-workspace)

如果启用了 `agents.defaults.sandbox`，非主会话可以在 `agents.defaults.sandbox.workspaceRoot` 下使用按会话隔离的工作区覆盖此设置（参见 [Gateway 网关配置](/gateway/configuration)）。

## 引导文件（注入）

在 `agents.defaults.workspace` 内，Fased 期望以下用户可编辑的文件：

- `AGENTS.md` — 操作指令 + "记忆"
- `SOUL.md` — 人设、边界、语气
- `TOOLS.md` — 用户维护的工具说明（例如 `imsg`、`sag`、约定）
- `BOOTSTRAP.md` — 一次性首次运行仪式（完成后删除）
- `IDENTITY.md` — 智能体名称/风格/表情
- `USER.md` — 用户档案 + 偏好称呼

在新会话的第一轮，Fased 将这些文件的内容直接注入智能体上下文。

空文件会被跳过。大文件会被修剪和截断并添加标记，以保持提示词精简（阅读文件获取完整内容）。

如果文件缺失，Fased 会注入一行"文件缺失"标记（`fased setup` 将创建安全的默认模板）。

`BOOTSTRAP.md` 仅在**全新工作区**（没有其他引导文件存在）时创建。如果你在完成仪式后删除它，后续重启不应重新创建。

要完全禁用引导文件创建（用于预置工作区），请设置：

```json5
{ agent: { skipBootstrap: true } }
```

## 内置工具

核心工具（read/exec/edit/write 及相关系统工具）始终可用，受工具策略约束。`apply_patch` 是可选的，由 `tools.exec.applyPatch` 控制。`TOOLS.md` **不**控制哪些工具存在；它是关于*你*希望如何使用它们的指导。

## Skills

Fased 从多个位置加载 Skills（名称冲突时工作区优先）：

- 内置（随安装包提供）
- 托管/本地：`~/.fased/skills`
- 个人 AgentSkills：`~/.agents/skills`
- 项目 AgentSkills：`<workspace>/.agents/skills`
- 工作区：`<workspace>/skills`

Skills 可通过配置/环境变量控制（参见 [Gateway 网关配置](/gateway/configuration) 中的 `skills`）。
普通 UI 中，安装、编辑、依赖设置和每 Agent allow/deny 都在 **Agent > Skills**。某个 Skill 可以存在于共享 library 中，但不允许给某个特定 Agent 使用。

## pi-mono 集成

Fased 复用 pi-mono 代码库的部分内容（模型/工具），但**会话管理、设备发现和工具连接由 Fased 负责**。

- 无 pi-coding 智能体运行时。
- 不读取 `~/.pi/agent` 或 `<workspace>/.pi` 设置。

## 会话

会话记录以 JSONL 格式存储在：

- `~/.fased/agents/<agentId>/sessions/<SessionId>.jsonl`

会话 ID 是稳定的，由 Fased 选择。
**不**读取旧版 Pi/Tau 会话文件夹。

## 流式传输中的引导

当队列模式为 `steer` 时，入站消息会注入当前运行。
队列在**每次工具调用后**检查；如果存在排队消息，当前助手消息的剩余工具调用将被跳过（工具结果显示错误"Skipped due to queued user message."），然后在下一个助手响应前注入排队的用户消息。

当队列模式为 `followup` 或 `collect` 时，入站消息会保留到当前轮次结束，然后使用排队的载荷开始新的智能体轮次。参见 [队列](/concepts/queue) 了解模式 + 防抖/上限行为。

分块流式传输在助手块完成后立即发送；默认为**关闭**（`agents.defaults.blockStreamingDefault: "off"`）。
通过 `agents.defaults.blockStreamingBreak` 调整边界（`text_end` 与 `message_end`；默认为 text_end）。
使用 `agents.defaults.blockStreamingChunk` 控制软块分块（默认 800–1200 字符；优先段落分隔，其次换行；最后是句子）。
使用 `agents.defaults.blockStreamingCoalesce` 合并流式块以减少单行刷屏（发送前基于空闲的合并）。非 Telegram 渠道需要显式设置 `*.blockStreaming: true` 以启用分块回复。
工具启动时发出详细工具摘要（无防抖）；Control UI 在可用时通过智能体事件流式传输工具输出。
更多详情：[流式传输 + 分块](/concepts/streaming)。

## 模型引用

模型引用通常在 **Agent > Models** 中选择。原始配置引用（例如 `agents.defaults.model`、`agents.defaults.models` 和 `agents.list[].model`）通过在**第一个** `/` 处分割来解析。

- 配置模型时使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 风格），请包含提供商前缀（例如：`openrouter/moonshotai/kimi-k2`）。
- 如果省略提供商，Fased 将输入视为别名或**默认提供商**的模型（仅在模型 ID 中没有 `/` 时有效）。

## 配置（最小）

至少需要设置：

- `agents.defaults.workspace`
- **Agent > Models** 中至少一个可用模型
- 如果该 Agent 要接收 Telegram、Discord、WhatsApp、Slack、Signal 或其他 app 消息，则在 **Agent > Channels** 中配置路由

---

_下一篇：[群聊](/channels/group-messages)_ 🦞
