---
read_when:
  - 解释 token 使用量、成本或上下文窗口时
  - 调试上下文增长或压缩行为时
summary: Fased 如何构建提示上下文并报告 token 使用量 + 成本
title: Token 使用与成本
x-i18n:
  generated_at: "2026-02-03T07:54:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: aee417119851db9e36890487517ed9602d214849e412127e7f534ebec5c9e105
  source_path: reference/token-use.md
  workflow: 15
---

# Token 使用与成本

Fased 跟踪的是 **token**，而不是字符。Token 是模型特定的，但大多数
OpenAI 风格的模型对于英文文本平均约 4 个字符为一个 token。

## 系统提示词如何构建

Fased 在每次运行时组装自己的系统提示词。它包括：

- 工具列表 + 简短描述
- Skills 列表（仅元数据；指令通过 `read` 按需加载）
- 自我更新指令
- 工作区 + 引导文件（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`（新建时），以及 canonical `MEMORY.md` 和存在时的兼容 `memory.md`）。大文件会被 `agents.defaults.bootstrapMaxChars`（默认：20000）截断，整体 bootstrap 注入由 `agents.defaults.bootstrapTotalMaxChars`（默认：150000）限制。`memory/*.md` 文件通过 memory tools 按需读取，不会自动注入。
- 时间（UTC + 用户时区）
- 回复标签 + 心跳行为
- 运行时元数据（主机/操作系统/模型/思考）

完整分解参见[系统提示词](/concepts/system-prompt)。

## 什么算入上下文窗口

模型接收的所有内容都计入上下文限制：

- 系统提示词（上面列出的所有部分）
- 对话历史（用户 + 助手消息）
- 工具调用和工具结果
- 附件/转录（图片、音频、文件）
- 压缩摘要和修剪产物
- 提供商包装或安全头（不可见，但仍计数）

对于图片，Fased 会在调用 provider 前缩小 transcript/tool image payload。可以用
`agents.defaults.imageMaxDimensionPx`（默认 `1200`）调整：

- 较低值通常减少 vision token 和 payload 大小。
- 较高值为 OCR/UI-heavy 截图保留更多细节。

有关实际分解（每个注入文件、工具、Skills 和系统提示词大小），使用 `/context list` 或 `/context detail`。参见[上下文](/concepts/context)。

## 如何查看 token 使用量

在 Control UI 中使用 **Usage** 页面查看本地用量账本。它报告来自以下来源的模型调用：

- chat sessions
- channel deliveries
- tasks 和 cron runs
- 存在 usage records 时的 CLI/system runs
- 只有在没有更好 run/transcript record 时才使用 session-store fallback counters

Usage 页面可以按 provider、model、agent、channel、task、session 和 source 分组。它显示 input、output、cache read/write、total tokens，以及存在 pricing 时的 cost。缺少 pricing 时只显示 token。

聊天命令是会话级控制：

- `/status` 显示当前 session model、context estimate、recent response token data 和 session key。
- `/usage off|tokens|full` 为当前会话附加可选的每回复页脚。
- `/usage cost` 从存储的 usage records 显示本地费用摘要。

CLI/provider 状态页面是另一类数据：

- `fased status --usage` 和模型/提供商状态命令可以显示 provider quota windows。
- Provider quota windows 是账号/提供商快照，不是本地每条消息计费总计。

## 成本估算（显示时）

成本从你的模型定价配置估算：

```
models.providers.<provider>.models[].cost
```

这些是 `input`、`output`、`cacheRead` 和
`cacheWrite` 的**每 1M token 美元**。如果缺少定价，Fased 仅显示 token。OAuth 令牌
永远不显示美元成本。

## 缓存 TTL 和修剪影响

提供商提示缓存仅在缓存 TTL 窗口内适用。Fased 可以
选择性地运行**缓存 TTL 修剪**：它在缓存 TTL
过期后修剪会话，然后重置缓存窗口，以便后续请求可以重用
新缓存的上下文，而不是重新缓存完整历史。这在会话空闲超过 TTL 时
可以降低缓存写入成本。

在可用时从 Agent > Models 配置它，或在 [Gateway 网关配置](/gateway/configuration) 中配置高级字段，并在
[会话修剪](/concepts/session-pruning) 中查看行为详情。

心跳可以在空闲间隙中保持缓存**热**。如果你的模型缓存 TTL
是 `1h`，将心跳间隔设置为略低于此（例如 `55m`）可以避免
重新缓存完整提示，从而降低缓存写入成本。

完整 knob-by-knob 指南参见 [Prompt Caching](/reference/prompt-caching)。

有关 Anthropic API 定价，缓存读取比输入 token 便宜得多，而缓存写入以更高的倍率计费。参见 Anthropic 的提示缓存定价了解最新费率和 TTL 倍率：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### 示例：用心跳保持 1 小时缓存热

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## 减少 token 压力的技巧

- 使用 `/compact` 来总结长会话。
- 在你的工作流中修剪大的工具输出。
- 保持 skill 描述简短（skill 列表会注入到提示中）。
- 对于冗长的探索性工作，优先使用较小的模型。

精确的 skill 列表开销公式参见 [Skills](/tools/skills)。
