---
summary: "Use ACP runtime sessions for Pi, Claude Code, Codex, OpenCode, Gemini CLI, and other harness agents"
read_when:
  - Running coding harnesses through ACP
  - Setting up thread-bound ACP sessions on thread-capable channels
  - Troubleshooting ACP backend and plugin wiring
  - Operating /acp commands from chat
title: "ACP Agents"
---

# ACP agents

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) sessions let
Fased run external coding harnesses through an ACP backend plugin. Examples
include Pi, Claude Code, Codex, OpenCode, and Gemini CLI.

If you ask Fased in plain language to "run this in Codex" or "start Claude Code
in a thread", Fased should route that request to the ACP runtime, not the native
sub-agent runtime.

## Fast operator flow

Use this when you want a practical `/acp` runbook:

1. Spawn a session:
   - `/acp spawn codex --mode persistent --thread auto`
2. Work in the bound thread (or target that session key explicitly).
3. Check runtime state:
   - `/acp status`
4. Tune runtime options as needed:
   - `/acp model <provider/model>`
   - `/acp permissions <profile>`
   - `/acp timeout <seconds>`
5. Nudge an active session without replacing context:
   - `/acp steer tighten logging and continue`
6. Stop work:
   - `/acp cancel` (stop current turn), or
   - `/acp close` (close session + remove bindings)

## Quick start for humans

Examples of natural requests:

- "Start a persistent Codex session in a thread here and keep it focused."
- "Run this as a one-shot Claude Code ACP session and summarize the result."
- "Use Gemini CLI for this task in a thread, then keep follow-ups in that same thread."

What Fased should do:

1. Pick `runtime: "acp"`.
2. Resolve the requested harness target (`agentId`, for example `codex`).
3. If thread binding is requested and the current channel supports it, bind the ACP session to the thread.
4. Route follow-up thread messages to that same ACP session until unfocused/closed/expired.

ACP and native subagent spawns also write run-history records as `subagent`
activity. Use **Agent > Tasks** to audit detached ACP/subagent work, open the
source session, and see delivery state. Use `/acp` controls or the bound thread
for ACP runtime control; run history does not replace the ACP backend.

## ACP versus sub-agents

Use ACP when you want an external harness runtime. Use sub-agents when you want
Fased-native delegated runs.

- Runtime:
  - ACP session: ACP backend plugin, for example `acpx`.
  - Sub-agent run: Fased native sub-agent runtime.
- Session key:
  - ACP session: `agent:<agentId>:acp:<uuid>`.
  - Sub-agent run: `agent:<agentId>:subagent:<uuid>`.
- Main commands:
  - ACP session: `/acp ...`.
  - Sub-agent run: `/subagents ...`.
- Spawn tool:
  - ACP session: `sessions_spawn` with `runtime:"acp"`.
  - Sub-agent run: `sessions_spawn` with the default runtime.

See also [Sub-agents](/tools/subagents).

## Thread-bound sessions (channel-agnostic)

When thread bindings are enabled for a channel adapter, ACP sessions can be bound to threads:

- Fased binds a thread to a target ACP session.
- Follow-up messages in that thread route to the bound ACP session.
- ACP output is delivered back to the same thread.
- Unfocus/close/archive/idle-timeout or max-age expiry removes the binding.

Thread binding support is adapter-specific. If the active channel adapter does
not support thread bindings, Fased returns a clear unsupported/unavailable
message.

Required feature flags for thread-bound ACP:

- `acp.enabled=true`
- `acp.dispatch.enabled=true`
- Channel-adapter ACP thread-spawn flag enabled (adapter-specific)
  - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`

### Thread supporting channels

- Any channel adapter that exposes session/thread binding capability.
- Current built-in support: Discord.
- Plugin channels can add support through the same binding interface.

## Start ACP sessions (interfaces)

### From `sessions_spawn`

Use `runtime: "acp"` to start an ACP session from an agent turn or tool call.

```json
{
  "task": "Open the repo and summarize failing tests",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

Notes:

- `runtime` defaults to `subagent`, so set `runtime: "acp"` explicitly for ACP
  sessions.
- If `agentId` is omitted, Fased uses `acp.defaultAgent` when configured.
- `mode: "session"` requires `thread: true` to keep a persistent bound conversation.

Interface details:

- `task` (required): initial prompt sent to the ACP session.
- `runtime` (required for ACP): must be `"acp"`.
- `agentId` (optional): ACP target harness id. Falls back to `acp.defaultAgent` if set.
- `thread` (optional, default `false`): request thread binding flow where supported.
- `mode` (optional): `run` (one-shot) or `session` (persistent).
  - default is `run`
  - if `thread: true` and mode omitted, Fased may default to persistent behavior
    per runtime path
  - `mode: "session"` requires `thread: true`
- `cwd` (optional): requested runtime working directory (validated by backend/runtime policy).
- `label` (optional): operator-facing label used in session/banner text.

### From `/acp` command

Use `/acp spawn` for explicit operator control from chat when needed.

```text
/acp spawn codex --mode persistent --thread auto
/acp spawn codex --mode oneshot --thread off
/acp spawn codex --thread here
```

Key flags:

- `--mode persistent|oneshot`
- `--thread auto|here|off`
- `--cwd <absolute-path>`
- `--label <name>`

See [Slash Commands](/tools/slash-commands).

## Session target resolution

Most `/acp` actions accept an optional session target (`session-key`, `session-id`, or `session-label`).

Resolution order:

1. Explicit target argument (or `--session` for `/acp steer`)
   - tries key
   - then UUID-shaped session id
   - then label
2. Current thread binding (if this conversation/thread is bound to an ACP session)
3. Current requester session fallback

If no target resolves, Fased returns a clear error (`Unable to resolve session target: ...`).

## Spawn thread modes

`/acp spawn` supports `--thread auto|here|off`.

- `auto`: in an active thread, bind that thread. Outside a thread, create/bind a
  child thread when supported.
- `here`: require current active thread; fail if not in one.
- `off`: no binding. Session starts unbound.

Notes:

- On non-thread binding surfaces, default behavior is effectively `off`.
- Thread-bound spawn requires channel policy support. For Discord, set
  `channels.discord.threadBindings.spawnAcpSessions=true`.

## ACP controls

Available command family:

- `/acp spawn`
- `/acp cancel`
- `/acp steer`
- `/acp close`
- `/acp status`
- `/acp set-mode`
- `/acp set`
- `/acp cwd`
- `/acp permissions`
- `/acp timeout`
- `/acp model`
- `/acp reset-options`
- `/acp sessions`
- `/acp doctor`
- `/acp install`

`/acp status` shows the effective runtime options and, when available, both
runtime-level and backend-level session identifiers.

Some controls depend on backend capabilities. If a backend does not support a
control, Fased returns a clear unsupported-control error.

## ACP command cookbook

- `/acp spawn`: create ACP session; optional thread bind.
  Example: `/acp spawn codex --mode persistent --thread auto --cwd /repo`
- `/acp cancel`: cancel in-flight turn for target session.
  Example: `/acp cancel agent:codex:acp:<uuid>`
- `/acp steer`: send steer instruction to running session.
  Example: `/acp steer --session support inbox prioritize failing tests`
- `/acp close`: close session and unbind thread targets.
  Example: `/acp close`
- `/acp status`: show backend, mode, state, runtime options, capabilities.
  Example: `/acp status`
- `/acp set-mode`: set runtime mode for target session.
  Example: `/acp set-mode plan`
- `/acp set`: generic runtime config option write.
  Example: `/acp set model openai/gpt-5.5`
- `/acp cwd`: set runtime working directory override.
  Example: `/acp cwd /Users/user/Projects/repo`
- `/acp permissions`: set approval policy profile.
  Example: `/acp permissions strict`
- `/acp timeout`: set runtime timeout in seconds.
  Example: `/acp timeout 120`
- `/acp model`: set runtime model override.
  Example: `/acp model anthropic/claude-opus-4-5`
- `/acp reset-options`: remove session runtime option overrides.
  Example: `/acp reset-options`
- `/acp sessions`: list recent ACP sessions from store.
  Example: `/acp sessions`
- `/acp doctor`: backend health, capabilities, actionable fixes.
  Example: `/acp doctor`
- `/acp install`: print deterministic install and enable steps.
  Example: `/acp install`

## Runtime options mapping

`/acp` has convenience commands and a generic setter.

Equivalent operations:

- `/acp model <id>` maps to runtime config key `model`.
- `/acp permissions <profile>` maps to runtime config key `approval_policy`.
- `/acp timeout <seconds>` maps to runtime config key `timeout`.
- `/acp cwd <path>` updates runtime cwd override directly.
- `/acp set <key> <value>` is the generic path.
  - Special case: `key=cwd` uses the cwd override path.
- `/acp reset-options` clears all runtime overrides for target session.

## acpx harness support (current)

Current acpx built-in harness aliases:

- `pi`
- `claude`
- `codex`
- `opencode`
- `gemini`

When Fased uses the acpx backend, prefer these values for `agentId` unless your
acpx config defines custom agent aliases.

Direct acpx CLI usage can also target arbitrary adapters via `--agent <command>`.
That raw escape hatch is an acpx CLI feature, not the normal Fased `agentId`
path.

## Required config

Core ACP baseline:

```json5
{
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["pi", "claude", "codex", "opencode", "gemini"],
    maxConcurrentSessions: 8,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200,
    },
    runtime: {
      ttlMinutes: 120,
    },
  },
}
```

Thread binding config is channel-adapter specific. Example for Discord:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
}
```

If thread-bound ACP spawn does not work, verify the adapter feature flag first:

- Discord: `channels.discord.threadBindings.spawnAcpSessions=true`

See [Configuration Reference](/gateway/configuration-reference).

## Plugin setup for acpx backend

ACPX is a bundled advanced extension in this release. Enable the bundled copy:

```bash
fased plugins enable acpx
```

Local workspace install during development:

```bash
fased plugins install ./extensions/acpx
```

Then verify backend health:

```text
/acp doctor
```

### Pinned acpx install strategy (current behavior)

The bundled ACPX extension enforces a strict plugin-local pinning model:

1. The extension pins an exact acpx dependency in `extensions/acpx/package.json`.
2. Runtime command is fixed to the plugin-local binary (`extensions/acpx/node_modules/.bin/acpx`), not global `PATH`.
3. Plugin config does not expose `command` or `commandArgs`, so runtime command drift is blocked.
4. Startup registers the ACP backend immediately as not-ready.
5. A background ensure job verifies `acpx --version` against the pinned version.
6. If missing/mismatched, it runs plugin-local install and re-verifies before
   healthy:
   `npm install --omit=dev --no-save acpx@<pinned>`

Notes:

- Fased startup stays non-blocking while acpx ensure runs.
- If network/install fails, backend remains unavailable and `/acp doctor` reports an actionable fix.

See [Plugins](/tools/plugin).

## Troubleshooting

- `ACP runtime backend is not configured`
  - Cause: backend plugin missing or disabled.
  - Fix: install and enable backend plugin, then run `/acp doctor`.
- `ACP is disabled by policy (acp.enabled=false)`
  - Cause: ACP globally disabled.
  - Fix: set `acp.enabled=true`.
- `ACP dispatch is disabled by policy (acp.dispatch.enabled=false)`
  - Cause: dispatch from normal thread messages disabled.
  - Fix: set `acp.dispatch.enabled=true`.
- `ACP agent "<id>" is not allowed by policy`
  - Cause: Agent not in allowlist.
  - Fix: use allowed `agentId` or update `acp.allowedAgents`.
- `Unable to resolve session target: ...`
  - Cause: bad key/id/label token.
  - Fix: run `/acp sessions`, copy exact key/label, retry.
- `--thread here requires running /acp spawn inside an active ... thread`
  - Cause: `--thread here` used outside a thread context.
  - Fix: move to target thread or use `--thread auto`/`off`.
- `Only <user-id> can rebind this thread.`
  - Cause: another user owns thread binding.
  - Fix: rebind as owner or use a different thread.
- `Thread bindings are unavailable for <channel>.`
  - Cause: adapter lacks thread binding capability.
  - Fix: use `--thread off` or move to supported adapter/channel.
- Missing ACP metadata for bound session
  - Cause: stale/deleted ACP session metadata.
  - Fix: recreate with `/acp spawn`, then rebind/focus thread.
