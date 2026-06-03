---
summary: "Agent loop lifecycle, streams, and wait semantics"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
title: "Agent Loop"
---

# Agent Loop

An agentic loop is the full “real” run of an agent: intake → context assembly → model inference →
tool execution → streaming replies → persistence. It’s the authoritative path that turns a message
into actions and a final reply, while keeping session state consistent.

In Fased, a loop is a single, serialized run per session that emits lifecycle and stream events
as the model thinks, calls tools, and streams output. This doc explains how that authentic loop is
wired end-to-end.

## Entry points

- Gateway RPC: `agent` starts a run; `agent.wait` waits for lifecycle completion.
- CLI: `fased agent` uses the Gateway by default. `--local` runs the local agent command path
  directly.

## How it works (high-level)

1. `agent` RPC validates params, resolves session (sessionKey/sessionId), persists session metadata, returns `{ runId, acceptedAt }` immediately.
2. `agentCommand` resolves the Agent, session, workspace, model defaults, thinking/verbose
   defaults, and skills snapshot, then chooses the runtime path:
   - ACP session path when the session is bound to ACP.
   - CLI-provider path for CLI-backed models.
   - Embedded Fased Agent runtime for normal provider-backed turns.
   - Fallback lifecycle end/error if the selected loop does not emit a terminal lifecycle event.
3. The embedded Fased Agent runtime:
   - serializes runs via per-session + global queues
   - resolves model + auth profile and builds the runtime session
   - subscribes to runtime events and streams assistant/tool deltas
   - enforces timeout -> aborts run if exceeded
   - returns payloads + usage metadata
4. The stream bridge maps runtime events to the Fased `agent` stream:
   - tool events => `stream: "tool"`
   - assistant deltas => `stream: "assistant"`
   - lifecycle events => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
   - compaction events => `stream: "compaction"`
   - reasoning events => `stream: "thinking"` when reasoning streaming is enabled
   - diagnostics => `stream: "diagnostic"` for strict-agentic/runtime warnings
5. `agent.wait` uses `waitForAgentJob`:
   - waits for **lifecycle end/error** for `runId`
   - gives transient lifecycle errors a short grace window so model/auth retry can emit a new start
   - returns `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Queueing + concurrency

- Runs are serialized per session key (session lane) and optionally through a global lane.
- This prevents tool/session races and keeps session history consistent.
- Messaging channels can choose queue modes (collect/steer/followup) that feed this lane system.
  See [Command Queue](/concepts/queue).

## Session + workspace preparation

- Workspace is resolved and created; sandboxed runs may redirect to a sandbox workspace root.
- Skills are loaded (or reused from a snapshot) and injected into env and prompt.
- Bootstrap/context files are resolved and injected into the system prompt report.
- A session write lock protects transcript persistence; `SessionManager` is opened and prepared
  before streaming.

## Prompt assembly + system prompt

- System prompt is built from the Fased base prompt, the skills prompt, bootstrap context, and per-run overrides.
- Model-specific limits and compaction reserve tokens are enforced.
- See [System prompt](/concepts/system-prompt) for what the model sees.

## Hook points (where you can intercept)

Fased has two hook systems:

- **Internal hooks** (Gateway hooks): event-driven scripts for commands and lifecycle events.
- **Plugin hooks**: extension points inside the agent/tool lifecycle and gateway pipeline.

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: runs while building bootstrap files before the system prompt is finalized.
  Use this to add/remove bootstrap context files.
- **Command hooks**: `/new`, `/reset`, `/stop`, and other command events (see Hooks doc).

See [Hooks](/automation/hooks) for setup and examples.

### Plugin hooks (agent + gateway lifecycle)

These run inside the agent loop or gateway pipeline:

- **`before_model_resolve`**: runs pre-session (no `messages`) to deterministically override provider/model before model resolution.
- **`before_prompt_build`**: runs after session load (with `messages`) to inject `prependContext`/`systemPrompt` before prompt submission.
- **`llm_input`**: observes the final model input immediately before the model call.
- **`before_agent_start`**: legacy compatibility hook that may run in either phase; prefer the explicit hooks above.
- **`agent_end`**: inspect the final message list and run metadata after completion.
- **`before_compaction` / `after_compaction`**: observe or annotate compaction cycles.
- **`before_tool_call` / `after_tool_call`**: intercept tool params/results.
- **`tool_result_persist`**: synchronously transform tool results before they are written to the session transcript.
- **`message_received` / `message_sending` / `message_sent`**: inbound + outbound message hooks.
- **`session_start` / `session_end`**: session lifecycle boundaries.
- **`gateway_start` / `gateway_stop`**: gateway lifecycle events.

See [Plugins](/tools/plugin#plugin-hooks) for the hook API and registration details.

## Streaming + partial replies

- Assistant deltas are streamed from the embedded runtime and emitted as `assistant` events.
- Block streaming can emit partial replies either on `text_end` or `message_end`.
- Reasoning streaming can be emitted as a separate stream or as block replies.
- See [Streaming](/concepts/streaming) for chunking and block reply behavior.

## Tool execution + messaging tools

- Tool `start`/`update`/`result` events are emitted on the `tool` stream.
- Tool results are sanitized for size and image payloads before logging/emitting.
- Messaging tool sends are tracked to suppress duplicate assistant confirmations.

## Reply shaping + suppression

- Final payloads are assembled from:
  - assistant text (and optional reasoning)
  - inline tool summaries (when verbose + allowed)
  - assistant error text when the model errors
- `NO_REPLY` is treated as a silent token and filtered from outgoing payloads.
- Messaging tool duplicates are removed from the final payload list.
- If no renderable payloads remain and a tool errored, a fallback tool error reply is emitted
  (unless a messaging tool already sent a user-visible reply).

## Compaction + retries

- Auto-compaction emits `compaction` stream events and can trigger a retry.
- On retry, in-memory buffers and tool summaries are reset to avoid duplicate output.
- See [Compaction](/concepts/compaction) for the compaction pipeline.

## Event streams (today)

- `lifecycle`: emitted by the runtime path and as a fallback by `agentCommand`
- `assistant`: streamed assistant deltas
- `tool`: streamed tool `start`/`update`/`result` events
- `compaction`: auto-compaction start/end and retry state
- `thinking`: streamed reasoning text when enabled
- `diagnostic`: runtime/strict-agentic warnings

## Chat channel handling

- Assistant deltas are buffered into chat `delta` messages.
- A chat `final` is emitted on **lifecycle end/error**.
- Tool events are broadcast to capable WebSocket subscribers. Tool details are stripped unless
  verbose mode allows them.

## Timeouts

- `agent.wait` default: 30s (just the wait). `timeoutMs` param overrides.
- `fased agent` through the Gateway sends a 600s timeout unless `--timeout` or
  `agents.defaults.timeoutSeconds` overrides it.
- Local/embedded runtime uses `agents.defaults.timeoutSeconds`; if unset, the code uses a long
  timer-safe runtime default. Explicit `0` means no practical timeout, clamped to Node's
  timer-safe maximum.

## Where things can end early

- Agent timeout (abort)
- AbortSignal (cancel)
- Gateway disconnect or RPC timeout
- `agent.wait` timeout (wait-only, does not stop agent)
