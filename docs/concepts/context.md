---
summary: "What context means in Fased, how it is built, and how to inspect it."
read_when:
  - You want to understand what context means in Fased
  - You are debugging why the model knows something or forgot it
  - You want to reduce context overhead (/context, /status, /compact)
title: "Context"
---

# Context

Context is everything Fased sends to the model for one run. It is bounded by the model's context window.

Beginner mental model:

- **System prompt** (Fased-built): rules, tools, skills list, time/runtime, and injected workspace files.
- **Conversation history**: your messages and the assistant's messages for this session.
- **Tool calls/results + attachments**: command output, file reads, images/audio, etc.
- **Run metadata**: channel/session routing, sender context, sandbox state, and runtime settings when relevant.

Context is not the same thing as memory. Memory can be stored on disk and reloaded later; context is what is inside the model's current window for this run.

## Quick start (inspect context)

- `/status`: quick window-usage view and session settings.
- `/context`: help for the context command.
- `/context list`: injected context and rough sizes.
- `/context detail`: per-file, per-tool schema, per-skill, and system prompt sizes.
- `/context json`: machine-readable context report.
- `/usage tokens`: append a per-reply usage footer to normal replies.
- `/compact`: summarize older history into a compact entry to free window space.

See also: [Slash commands](/tools/slash-commands), [Token use & costs](/reference/token-use), [Compaction](/concepts/compaction).

## Example output

Values vary by model, provider, tool policy, and what is in your workspace.

### `/context list` shape

```
Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Bootstrap max/total: 150,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)
- MEMORY.md: OK | raw 128 chars (~32 tok) | injected 128 chars (~32 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Skills: docs, frontend-design, ...
Tool list (system prompt text): 0 chars (~0 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: read, edit, write, exec, process, browser, message, sessions_send, ...

Session tokens (cached): 14,250 total / ctx=32,000
```

The exact values vary by provider, model, configured tools, enabled skills, sandbox policy, and workspace content.

### `/context detail` shape

```
Context breakdown (detailed)
...
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
... (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
... (+N more tools)
```

## What counts toward the context window

Everything the model receives counts, including:

- System prompt (all sections).
- Conversation history.
- Tool calls + tool results.
- Attachments/transcripts (images/audio/files).
- Compaction summaries and pruning artifacts.
- Provider adapter additions when they are part of the prompt payload.

## How Fased builds the system prompt

The system prompt is Fased-owned and rebuilt each run. It includes:

- Tool list + short descriptions.
- Skills list (metadata only; see below).
- Workspace location.
- Time (UTC + converted user time if configured).
- Runtime metadata (host/OS/model/thinking).
- Injected workspace bootstrap files under **Project Context**.

Full breakdown: [System Prompt](/concepts/system-prompt).

## Injected workspace files (Project Context)

For full Agent runs, Fased injects recognized workspace files when present:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (first-run only)
- `MEMORY.md`
- `memory.md`

Large files are truncated per file using `agents.defaults.bootstrapMaxChars` (default `20000` chars). Fased also enforces a total bootstrap injection cap across files with `agents.defaults.bootstrapTotalMaxChars` (default `150000` chars). `/context` shows raw vs injected sizes and whether truncation happened.

Lightweight runs may use a smaller context set. Heartbeat runs keep `HEARTBEAT.md`; sub-agent and cron sessions use a reduced bootstrap allowlist.

## Skills: what is injected vs loaded on-demand

The system prompt includes a compact skills list: name, description, and location. This list has real overhead.

Skill instructions are not included by default. The model is expected to read the skill's `SKILL.md` only when needed.

## Tools: there are two costs

Tools affect context in two ways:

1. **Tool list text** in the system prompt (what you see as "Tooling").
2. **Tool schemas** (JSON). These are sent to the model so it can call tools. They count toward context even though you do not see them as plain text.

`/context detail` breaks down the biggest tool schemas so you can see what dominates.

## Commands, directives, and inline shortcuts

Slash commands are handled by the Gateway. There are a few different behaviors:

- **Standalone commands**: a message that is only `/...` runs as a command.
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` are stripped before the model sees the message.
  - Directive-only messages persist session settings.
  - Inline directives in a normal message act as per-message hints.
- **Inline shortcuts** (allowlisted senders only): certain `/...` tokens inside a normal message can run immediately, such as `hey /status`, and are stripped before the model sees the remaining text.

Details: [Slash commands](/tools/slash-commands).

## Sessions, compaction, and pruning (what persists)

What persists across messages depends on the mechanism:

- **Normal history** persists in the session transcript until the session is reset, deleted, or compacted.
- **Compaction** persists a summary into the transcript and keeps recent messages intact.
- **Pruning** removes old tool results from the in-memory prompt for a run, but does not rewrite the transcript.

Docs: [Session](/concepts/session), [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning).

## What `/context` actually reports

`/context` prefers the latest run-built system prompt report when available:

- `System prompt (run)` = captured from the last embedded (tool-capable) run and persisted in the session store.
- `System prompt (estimate)` = computed on the fly when no run report exists or when the current backend does not generate the report.

Either way, it reports sizes and top contributors. It does not dump the full system prompt or raw tool schemas unless you explicitly use the JSON report for diagnostics.
