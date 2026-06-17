---
summary: "Context window, compaction, memory flush, and checkpoint behavior for long-running Fased sessions."
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

# Context Window and Compaction

Every model has a context window: the maximum number of tokens it can see for
one run. Long-running chats accumulate messages and tool results. Once the
window gets tight, Fased compacts older history and keeps the session usable.

## What compaction is

Compaction summarizes older conversation into a compact summary entry and keeps
recent messages intact. The summary is stored in the session JSONL history, so
future requests use:

- The compaction summary
- Recent messages after the compaction point

Compaction is persistent. It is different from session pruning, which only
trims old tool results from the in-memory request context.

## Configuration

Use `agents.defaults.compaction` in `fased.json` when you need to tune behavior:

- `mode`: `safeguard` is the default unless you explicitly set another mode.
- `reserveTokens` and `keepRecentTokens`: tune the compaction cut point.
- `reserveTokensFloor`: minimum headroom Fased enforces for embedded runs.
- `maxHistoryShare`: safeguard limit for how much of the context window history can occupy.
- `timeoutSeconds`: safety timeout for compaction calls.
- `identifierPolicy`: defaults to `strict` so opaque ids are preserved in summaries.
- `memoryFlush`: optional pre-compaction memory flush settings.

Use `identifierPolicy: "off"` only if identifier preservation is getting in
the way. Use `identifierPolicy: "custom"` with `identifierInstructions` when a
workspace has specific ids, ticket keys, or customer-safe references that must
survive compaction.

## Auto-compaction (default on)

When a session nears or exceeds the model's context window, Fased can compact
the session and retry the original request using the compacted context. In
practice this happens through:

- threshold maintenance after a successful turn
- overflow recovery when the provider reports a context overflow
- an explicit `/compact` command from an authorized sender

You will see:

- `Auto-compaction complete` in verbose mode
- `/status` showing the compaction count
- Agent > Sessions showing compaction checkpoints when snapshots are available

Before compaction, Fased can run a silent memory flush turn to store
durable notes to disk. See [Memory](/concepts/memory) for details and config.

## Manual compaction

Use `/compact` from an authorized session to force a compaction pass. Optional instructions guide the summary:

```
/compact Focus on decisions and open questions
```

If there is not enough history to compact, the command returns a skipped result
instead of rewriting the session.

## Compaction checkpoints

When a checkpoint snapshot is available, Agent > Sessions can show compaction checkpoints with Branch and Restore actions:

- **Branch** creates a new session from the checkpoint snapshot.
- **Restore** restores the current session from that checkpoint snapshot.

Checkpoints are retained as bounded local artifacts and are exposed through the
session APIs without leaking raw transcript paths to the UI.

## Context window source

Context window is model-specific. Fased uses the model definition from the configured provider catalog to determine limits.

## Compaction vs pruning

- **Compaction**: summarizes older conversation and persists the summary in JSONL.
- **Session pruning**: trims old tool results only, in memory, per request.

See [/concepts/session-pruning](/concepts/session-pruning) for pruning details.

## OpenAI server-side compaction

Fased also supports OpenAI Responses server-side compaction hints for compatible
direct OpenAI models. This is separate from local Fased compaction and can run
alongside it.

- Local compaction: Fased summarizes and persists into session JSONL.
- Server-side compaction: OpenAI compacts context on the provider side when `store` and `context_management` are enabled.

See [OpenAI provider](/providers/openai) for model params and overrides.

## Tips

- Use `/compact` when sessions feel stale or context is bloated.
- Large tool outputs are already truncated; pruning can further reduce tool-result buildup.
- If you need a fresh slate, `/new` or `/reset` starts a new session id.
- If compaction still overflows, switch to a larger-context model or reset the session.
