---
summary: "Compatibility reference for the legacy fased cron command."
read_when:
  - You are maintaining scripts that still call fased cron
  - You need the low-level scheduler compatibility command
title: "cron compatibility"
---

# `fased cron`

`fased cron` is the compatibility command for the Gateway task scheduler.
Prefer [`fased task`](/cli/task) in new operator docs and normal use.

Browser equivalent: **Agent > Tasks**. The `cron.*` storage and RPC names are
implementation details retained for compatibility.

Related:

- Task CLI: [task](/cli/task)
- Scheduled tasks: [Scheduled Tasks](/automation/cron-jobs)
- Agent/session task model: [Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks)

Tip: run `fased task --help` for the user-facing command surface.

Note: isolated tasks created with `fased task add` default to `--announce`
delivery. Use `--no-deliver` to keep output internal. `--deliver` remains as a
deprecated alias for `--announce`.

Note: one-shot (`--at`) tasks delete after success by default. Use `--keep-after-run` to keep them.

Note: recurring tasks use exponential retry backoff after consecutive errors
(30s -> 1m -> 5m -> 15m -> 60m), then return to normal schedule after the
next successful run.

Note: retention/pruning is controlled in config:

- `cron.sessionRetention` (default `24h`) prunes completed isolated run sessions.
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` prune `~/.fased/cron/runs/<jobId>.jsonl`.

Modern scheduled work should be created with explicit ownership:

```bash
fased task add \
  --agent research \
  --session-key "agent:research:webchat:direct:service-watch" \
  --name "Service watch" \
  --every 1h \
  --session isolated \
  --message "Check provider status and report here." \
  --announce \
  --channel telegram \
  --to "123456789"
```

The same task can also be created from WebChat with **Schedule this** or from a
channel chat with `/task new`. Those paths still write the same internal
scheduler-backed task shape.
For channel users, prefer natural task text first:

```text
/task new every 1h Service watch: Check provider status with a cheap check first and escalate if deeper analysis is needed.
```

The planner stores the cheap-first evaluator policy; the runtime injects the
human-readable escalation cue itself.

## Common edits

Update delivery settings without changing the message:

```bash
fased task edit <task-id> --announce --channel telegram --to "123456789"
```

Disable delivery for an isolated task:

```bash
fased task edit <task-id> --no-deliver
```

Announce to a specific channel:

```bash
fased task edit <task-id> --announce --channel slack --to "channel:C1234567890"
```
