---
title: "Prompt Caching"
summary: "Prompt caching knobs、merge order、provider 行为和 tuning patterns"
read_when:
  - 你想用 cache retention 降低 prompt token cost
  - 你需要 multi-agent setup 中的 per-agent cache behavior
  - 你要一起调 heartbeat 和 cache-ttl pruning
---

# Prompt caching

Prompt caching 表示模型提供商可以跨回合复用未变化的 prompt prefix（通常是 system/developer instructions 和稳定上下文），而不是每次重新处理。第一次匹配请求写入 cache tokens（`cacheWrite`），后续匹配请求读取 cache（`cacheRead`）。

作用：降低 token cost、加快响应，并让长会话性能更稳定。没有 caching 时，即使大部分输入没有变化，重复 prompts 也会每回合支付完整 prompt 成本。

Anthropic pricing 参考：
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

## 主要 knobs

### `cacheRetention`

在 model params 上设置：

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # none | short | long
```

Per-agent override：

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

Merge order：

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params`（匹配 agent id 后按 key override）

### Legacy `cacheControlTtl`

Legacy values 仍接受并映射：

- `5m` -> `short`
- `1h` -> `long`

新配置优先用 `cacheRetention`。

### `contextPruning.mode: "cache-ttl"`

缓存 TTL 窗口过期后修剪旧 tool-result context，避免 idle 后请求重新缓存过大的历史。

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

完整行为见 [Session Pruning](/concepts/session-pruning)。

### Heartbeat keep-warm

Heartbeat 可以保持 cache window warm，减少 idle gap 后重复 cache writes。

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

Per-agent heartbeat 支持 `agents.list[].heartbeat`。

## Provider behavior

### Anthropic direct API

- 支持 `cacheRetention`。
- 使用 Anthropic API-key auth profiles 时，Fased 会为未设置的 Anthropic model refs seed `cacheRetention: "short"`。

### OpenRouter Anthropic models

对 `openrouter/anthropic/*` model refs，Fased 会在 system/developer prompt blocks 上注入 Anthropic `cache_control` 来提高 prompt-cache reuse。

### Other providers

Provider 不支持此 cache mode 时，`cacheRetention` 没有效果。

## Cache diagnostics

Fased 提供 cache-trace diagnostics：

```yaml
diagnostics:
  cacheTrace:
    enabled: true
    filePath: "~/.fased/logs/cache-trace.jsonl"
    includeMessages: false
    includePrompt: false
    includeSystem: false
```

一次性 env toggles：

- `FASED_CACHE_TRACE=1`
- `FASED_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl`
- `FASED_CACHE_TRACE_MESSAGES=0|1`
- `FASED_CACHE_TRACE_PROMPT=0|1`
- `FASED_CACHE_TRACE_SYSTEM=0|1`

Usage 页面通过 `cacheRead` 和 `cacheWrite` 显示每回合 cache token impact。`/usage full` 仍可显示当前会话的 per-response footer，但 Usage 页面更适合 provider/model/accounting review。

## 快速排查

- 大多数 turns 都有高 `cacheWrite`：检查 volatile system-prompt inputs，并确认 model/provider 支持 cache settings。
- `cacheRetention` 无效：确认 model key 匹配 `agents.defaults.models["provider/model"]`。
- 不支持兼容 cache 的 providers 可能忽略 Fased cache settings 或不显示 cache-token effect。
