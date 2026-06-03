---
title: "Memory Config Reference"
summary: "builtin memory search、session archives、QMD backend 和 per-Agent memory 配置"
read_when:
  - 你要配置普通 UI 之外的 Agent memory
  - 你要在 builtin memory search 与 QMD 之间选择
  - 你要调试 memory roots、indexing、session archives 或 QMD status
---

# Memory Config Reference

普通用户应从 **Agent > Memory** 开始。本页是该 UI 背后配置字段的运维参考。

Fased memory 有四层：

1. Workspace Markdown 文件：`MEMORY.md` 和 `memory/*.md`。
2. Session archive hook：启用后，在 `/new` 和 `/reset` 时写入轻量 artifacts。
3. Memory tools：`memory_search` 和 `memory_get`，通常由 `memory-core` plugin 提供。
4. Search backend：默认 builtin SQLite/vector index，或可选 QMD。

全局 Memory 页面是诊断视图。Per-Agent archive controls 位于 Agent > Memory。

## 默认布局

| Path                               | Purpose                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `<workspace>/MEMORY.md`            | canonical curated memory file。workspace setup 时创建。 |
| `<workspace>/memory/`              | daily/session/topic memory Markdown files。             |
| `<workspace>/memory.md`            | compatibility root。`MEMORY.md` 存在时缺失不是错误。    |
| `~/.fased/memory/<agentId>.sqlite` | builtin memory search index 默认位置。                  |
| `~/.fased/agents/<agentId>/qmd/`   | `memory.backend = "qmd"` 时的 QMD home。                |

## Agent memory search

Memory search 配置在 `agents.defaults.memorySearch`，也可用 `agents.list[].memorySearch` 做 per-Agent override。

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        enabled: true,
        sources: ["memory"],
        provider: "openai", // openai | gemini | voyage | mistral | local
        fallback: "none",
        query: {
          maxResults: 6,
          minScore: 0.2,
          hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
        },
      },
    },
  },
}
```

关键字段：

| Field                                                 | Purpose                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `enabled`                                             | 为可用 Agent 启用 memory tools。                                       |
| `sources`                                             | `"memory"` 索引 Markdown memory files；`"sessions"` 是实验性来源。     |
| `extraPaths`                                          | 额外 Markdown 文件或目录。必须审核。                                   |
| `provider`                                            | embedding provider：`openai`、`gemini`、`voyage`、`mistral`、`local`。 |
| `remote.baseUrl` / `remote.apiKey` / `remote.headers` | custom remote embedding endpoint。                                     |
| `local.modelPath`                                     | local embeddings 的 GGUF path 或 supported local model reference。     |
| `fallback`                                            | primary provider 失败时的 fallback。严格本地时用 `"none"`。            |
| `store.path`                                          | SQLite store path，支持 `{agentId}`。                                  |
| `query.hybrid.*`                                      | BM25 + vector search merge settings。                                  |
| `cache.*`                                             | in-process memory search cache。                                       |
| `sync.*`                                              | file watcher/session sync controls。                                   |

常见 provider 的 memory search API key 可来自 provider auth/config/env。custom endpoint 使用 `memorySearch.remote.apiKey`。

## Builtin backend

Builtin backend 索引 Markdown memory files，并用 path/line metadata 返回 `memory_search` snippets。

适合使用 builtin memory 的情况：

- 想使用默认设置。
- 想减少 moving parts。
- 不需要 QMD sidecar。
- 想让 Agent > Memory diagnostics 不依赖额外工具。

## QMD backend

QMD 是可选且偏高级/实验性的 backend。只有需要本地 sidecar 做 BM25/vector/rerank style retrieval 时才启用。

```json5
{
  memory: {
    backend: "qmd",
    citations: "auto",
    qmd: {
      command: "qmd",
      includeDefaultMemory: true,
      searchMode: "search",
      update: { interval: "5m", debounceMs: 15000, onBoot: true },
      limits: { maxResults: 6, maxSnippetChars: 700, timeoutMs: 4000 },
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
      paths: [{ name: "notes", path: "~/notes", pattern: "**/*.md" }],
    },
  },
}
```

QMD prereqs：

- Gateway `PATH` 上存在 `qmd`，或设置 `memory.qmd.command`。
- Bun 和 SQLite 支持。
- macOS 或 Linux；Windows 建议通过 WSL2。

QMD 失败时，Fased 会尽可能回退到 builtin search path，并在 Memory diagnostics 中报告 backend 状态。

## Session archive hook

`session-memory` hook 在 session reset 或 new session 开始时写 session artifacts。Agent > Memory 是普通控制面。

看到 `memory/ - directory, 0 markdown files` 通常表示 archive path 已准备好，但还没有合格的 `/new` 或 `/reset` 事件写入内容。

## Task memory scope

Tasks 使用 owning Agent 的 memory policy。任务仍可能按 memory scope 隐藏 memory tools：

| Scope behavior      | Effect                                                            |
| ------------------- | ----------------------------------------------------------------- |
| No memory           | 清除 prior transcript context，隐藏 memory tools。                |
| Restricted memory   | 只显示配置允许的 memory/session tools。                           |
| Agent/search memory | memory plugin 和 tool policy 都允许时可显示 `memory_search/get`。 |

## Diagnostics

- **Agent > Memory**：选定 Agent 的 archive state、roots、backend、QMD、plugin 和 validation。
- **Memory page**：cross-Agent diagnostics 和 overview。
- **Advanced > Debug**：Memory Doctor repair preview 和 gated repair。
- `fased memory status --agent <id>`
- `fased memory doctor --agent <id>`

Repair execution 有意加 gate。inventory/validation 是只读；repair 需要明确 operator action。
