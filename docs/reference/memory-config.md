---
title: "Memory Config Reference"
summary: "Builtin memory search, session archives, QMD backend, and per-Agent memory configuration"
read_when:
  - Configuring Agent memory beyond the normal UI
  - Choosing builtin memory search vs QMD
  - Debugging memory roots, indexing, session archives, or QMD status
---

# Memory Config Reference

Normal users should start with **Agent > Memory**. This page is the operator
reference for the config fields behind that UI.

Fased memory has four layers:

1. Workspace Markdown files: `MEMORY.md` and `memory/*.md`.
2. Session archive hook: writes lightweight artifacts during `/new` and
   `/reset` when enabled.
3. Memory tools: `memory_search` and `memory_get`, normally provided by the
   `memory-core` plugin.
4. Search backend: builtin SQLite/vector index by default, or optional QMD.

The global Memory page is diagnostic. Per-Agent archive controls live in
Agent > Memory.

Fased ships a small deterministic **Memory Wiki** export. It is not a competing
memory backend and does not write new memories. It reads the selected Agent's
`MEMORY.md` and `memory/*.md`, then writes a compiled read-only Markdown view
under the Fased state directory. Rebuild it from **Agent > Memory > Rebuild
wiki** or the `doctor.memory.wiki.rebuild` RPC.

## Default Layout

| Path                               | Purpose                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `<workspace>/MEMORY.md`            | Canonical curated memory file. Fased creates it during workspace setup.   |
| `<workspace>/memory/`              | Daily/session/topic memory Markdown files.                                |
| `<workspace>/memory.md`            | Compatibility root only. Missing is not an error when `MEMORY.md` exists. |
| `~/.fased/memory/<agentId>.sqlite` | Builtin memory search index by default.                                   |
| `~/.fased/memory-wiki/<agentId>/`  | Deterministic read-only Memory Wiki export.                               |
| `~/.fased/agents/<agentId>/qmd/`   | QMD home when `memory.backend = "qmd"`.                                   |

## Agent Memory Search

Configure memory search under `agents.defaults.memorySearch` and optionally
override per Agent with `agents.list[].memorySearch`.

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
          hybrid: {
            enabled: true,
            vectorWeight: 0.7,
            textWeight: 0.3,
          },
        },
      },
    },
  },
}
```

Key fields:

- `enabled`: enables memory tools for Agents that can use them.
- `sources`: `"memory"` indexes Markdown memory files. `"sessions"` is gated by
  experimental session-memory indexing.
- `extraPaths`: extra Markdown files or directories to index. Keep paths
  reviewed.
- `provider`: embedding provider: `openai`, `gemini`, `voyage`, `mistral`, or
  `local`.
- `remote.baseUrl`, `remote.apiKey`, `remote.headers`: custom remote embedding
  endpoint settings.
- `remote.batch.*`: batch embedding indexing for supported remote providers.
- `local.modelPath`: GGUF path or supported local model reference for local
  embeddings.
- `fallback`: fallback provider when the primary provider fails. Use `"none"`
  for strict local-only behavior.
- `store.path`: SQLite store path. Supports `{agentId}`.
- `query.hybrid.*`: BM25 + vector search merge settings.
- `cache.*`: in-process memory search cache settings.
- `sync.*`: file watcher/session sync controls.

Memory search API keys can come from provider auth/config/env for common
providers. For custom endpoints, use `memorySearch.remote.apiKey`.

## Builtin Backend

The builtin backend indexes Markdown memory files and serves `memory_search`
snippets with path and line metadata.

Use builtin memory when:

- you want the default setup
- you want fewer moving parts
- you do not need a QMD sidecar
- you want Agent > Memory diagnostics without installing extra tools

Builtin index content:

- `MEMORY.md`
- `memory/**/*.md`
- reviewed `extraPaths`
- optional session sources when configured

## QMD Backend

QMD is optional and experimental. Enable it only when you want a local sidecar
for BM25/vector/rerank style memory retrieval.

```json5
{
  memory: {
    backend: "qmd",
    citations: "auto",
    qmd: {
      command: "qmd",
      includeDefaultMemory: true,
      searchMode: "search",
      update: {
        interval: "5m",
        debounceMs: 15000,
        onBoot: true,
        waitForBootSync: false,
        embedInterval: "60m",
      },
      limits: {
        maxResults: 6,
        maxSnippetChars: 700,
        timeoutMs: 4000,
      },
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
      paths: [{ name: "notes", path: "~/notes", pattern: "**/*.md" }],
    },
  },
}
```

QMD prereqs:

- `qmd` binary on the Gateway `PATH`, or set `memory.qmd.command`.
- Bun and SQLite support expected by QMD.
- macOS or Linux. Windows is best through WSL2.

QMD fields:

| Field                             | Purpose                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `memory.backend`                  | `"builtin"` or `"qmd"`.                                   |
| `memory.citations`                | `auto`, `on`, or `off` snippet citation behavior.         |
| `memory.qmd.command`              | QMD executable path.                                      |
| `memory.qmd.searchMode`           | `search`, `vsearch`, or `query`.                          |
| `memory.qmd.includeDefaultMemory` | Index workspace `MEMORY.md` and `memory/**/*.md`.         |
| `memory.qmd.paths[]`              | Additional QMD collections.                               |
| `memory.qmd.sessions.enabled`     | Export sanitized session transcripts to a QMD collection. |
| `memory.qmd.update.*`             | Refresh and embedding cadence/timeouts.                   |
| `memory.qmd.limits.*`             | Result, snippet, injected char, and timeout caps.         |
| `memory.qmd.scope`                | Session/channel policy for where QMD recall is allowed.   |

When QMD fails, Fased falls back to the builtin search path where possible and
reports backend state in Memory diagnostics.

## Session Archive Hook

The `session-memory` hook writes session artifacts when a session is reset or a
new session starts. Agent > Memory is the normal control surface.

Seeing `memory/ - directory, 0 markdown files` usually means the archive path is
ready but no qualifying `/new` or `/reset` event has written content yet.

## Memory Wiki Export

Memory Wiki is an operator export, not automatic recall. It compiles reviewed
memory Markdown into `~/.fased/memory-wiki/<agentId>/index.md` and source pages.

Properties:

- source files stay in the Agent workspace
- output files stay under the Fased state directory
- filenames are capped and sanitized
- reads and writes use root-confined filesystem helpers
- rebuild is explicit and audited as an admin RPC

Use it when you want a durable, browseable knowledge vault generated from
existing memory. Use builtin/QMD memory search when the Agent needs retrieval
during chat or tasks.

## Task Memory Scope

Tasks use the owning Agent's memory policy. A task may still block memory tools
depending on its memory scope:

| Scope Behavior      | Effect                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| No memory           | Prior transcript context is cleared and memory tools are hidden.                                   |
| Restricted memory   | Only the configured memory/session tools are shown.                                                |
| Agent/search memory | `memory_search` and `memory_get` can be available if the memory plugin and tool policy allow them. |

Check task run logs and Agent > Tasks for requested/effective memory scope.

## Diagnostics

Use these surfaces:

- **Agent > Memory**: selected Agent archive state, roots, backend, QMD, plugin,
  and validation.
- **Memory page**: cross-Agent diagnostics and memory overview.
- **Advanced > Debug**: Memory Doctor repair preview and gated repair.
- `fased memory status --agent <id>`
- `fased memory doctor --agent <id>`

Repair execution is intentionally gated. Memory Doctor inventory/validation are
read-only; repair execution requires an explicit operator action.

Related docs:

- [Memory](/concepts/memory)
- [Memory Doctor](/concepts/memory-doctor)
- [Agent workspace](/concepts/agent-workspace)
- [Session management + compaction](/reference/session-management-compaction)
