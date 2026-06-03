---
summary: "Schedule, inspect, and operate Agent tasks from the CLI."
read_when:
  - You want scheduled tasks and wakeups
  - You are debugging task execution and run history
title: "task"
---

# `fased task`

Use `fased task` to manage Agent-owned scheduled work from the terminal.

Browser equivalent: **Agent > Tasks** for the selected Agent.

Related:

- [Scheduled Tasks](/automation/cron-jobs)
- [Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks)
- [Task Operating Layer](/concepts/task-operating-layer)

Run `fased task --help` for the full command surface.

## Common flow

Create a recurring isolated task:

```bash
fased task add \
  --agent ops \
  --session-key "agent:ops:webchat:direct:health-review" \
  --name "Service health review" \
  --every 1h \
  --session isolated \
  --message "Check service health and report here." \
  --announce \
  --channel telegram \
  --to "123456789"
```

Choose exactly one schedule flag: `--at`, `--every`, or `--cron`. Isolated
tasks use `--message`. Main-session tasks use `--system-event`.

Operate the task:

```bash
fased task list
fased task run <task-id>
fased task run <task-id> --due
fased task edit <task-id> --every 30m
fased task disable <task-id>
fased task enable <task-id>
fased task rm <task-id>
```

Inspect runs:

```bash
fased task runs --id <task-id> --limit 50
fased task last <task-id>
fased task run-show <run-id>
```

## Run control

Use run-id commands when a specific queued or leased run is stuck, failed, or
needs retry:

```bash
fased task status
fased task cancel-run <run-id>
fased task retry-run <run-id>
fased task clear-stale <run-id>
```

These operate on run ids, not task ids.

## Repair and sources

When a task stops because access, source quality, or evidence is missing, use:

```bash
fased task repair <task-id> configure
fased task repair <task-id> add-source "https://example.com/source"
fased task repair <task-id> retry
fased task repair <task-id> stop-source <source-node-id>
```

Trusted source memory:

```bash
fased task sources list
fased task sources add <task-id> "https://example.com/source"
fased task sources show <trusted-source-id>
fased task sources enable <trusted-source-id>
fased task sources disable <trusted-source-id>
fased task sources forget <trusted-source-id>
```

## Workflows and graphs

Inspect workflow runs:

```bash
fased task flow list --agent research
fased task flow show <flow-id>
fased task flow cancel <flow-id> --reason "operator stop"
```

Preview or run graph JSON:

```bash
fased task workflow preview --file ./release-workflow.json
fased task workflow run --file ./release-workflow.json --agent research
```

## Ask Agents

Tasks can store coordination intent for local Agent review:

```bash
fased task ask <task-id> --agent research
fased task approve <task-id>
```

The run detail shows helper Agent evidence under the same run-history chain.

## Workers

Run an external task worker:

```bash
fased task worker
fased task worker --once
fased task worker --worker-id worker-a --max-runs 2 --poll-ms 500
```

Install a supervised worker:

```bash
fased task worker install
fased task worker status
fased task worker restart
```

The gateway schedules runs. Workers lease queued steps and write results back to
the same local task store.

## Smoke checks

```bash
fased task smoke
fased task smoke --channel telegram --to "123456789"
fased task smoke --skill wallet --input '{"action":"balance"}'
fased task smoke --model openrouter/provider-model
fased task smoke --repair
```

Use `--keep` when you want to retain temporary smoke tasks for inspection.

## Channel commands

Connected command surfaces can create and edit tasks with natural text:

```text
/task new remind me every hour to stand up
/task new check provider health hourly
/task edit <id> every 30m
/task edit <id> send here
/task edit <id> use no model
/task edit <id> stop after success
```

Tasks created from Chat, Telegram, Discord, Slack, or another channel are still
owned by an Agent and Session and appear in **Agent > Tasks**.

## Compatibility

The internal RPC/storage names still use `cron.*` and `~/.fased/cron/...`.
Prefer `fased task ...` in user docs and normal operator instructions.
