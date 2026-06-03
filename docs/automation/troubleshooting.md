---
summary: "Troubleshoot scheduler, delivery, and heartbeat automation"
read_when:
  - A scheduled task did not run
  - A scheduled task ran but nothing was delivered
  - Heartbeat feels quiet or skipped
title: "Automation Troubleshooting"
---

# Automation troubleshooting

Use this page when scheduled work is missing, delayed, or delivering to the
wrong place. It covers the gateway scheduler, task activity logs, heartbeat behavior,
and outbound delivery checks.

## Fast check ladder

In the browser UI, check these first:

1. **Agents > selected Agent > Tasks**: task enabled, next run, last run, and run details.
2. **Agents > Channels**: delivery channel is connected and routed.
3. **Usage**: token usage appears when a task actually ran a model call.
4. **Logs**: gateway log tail for scheduler, channel, or model errors.

Start with the broad runtime checks:

```bash
fased status
fased gateway status
fased logs --follow
fased doctor
fased channels status --probe
```

Then move to automation-specific state:

```bash
fased task status
fased task list
fased system heartbeat last
```

## Task not firing

```bash
fased task status
fased task list
fased task runs --id <jobId> --limit 20
fased task run-show <runId>
fased logs --follow
```

Healthy signs:

- `fased task status` reports the scheduler enabled and a future `nextWakeAtMs`
- the task is enabled and its schedule parses cleanly
- recent task runs show `ok` or a clear skip reason

Common signatures:

- `cron: scheduler disabled; jobs will not run automatically`
  - the scheduler is disabled in config or via env
- `cron: timer tick failed`
  - the scheduler loop threw; inspect surrounding logs
- `reason: not-due`
  - you manually called `task run` without forcing a not-yet-due task
- expired queue lease in `task status`
  - use `fased task clear-stale <runId>` to requeue that run
- failed, blocked, canceled, or recovered queue run
  - use `fased task retry-run <runId>` after fixing the cause
- active run that should stop
  - use `fased task cancel-run <runId>`
- unclear run source or delivery path
  - use `fased task run-show <runId>` to inspect queue steps, adapter/model,
    delivery, recovery actions, and transcript path

## Task ran but no delivery happened

```bash
fased task runs --id <jobId> --limit 20
fased task run-show <runId>
fased task list
fased channels status --probe
fased logs --follow
```

Healthy signs:

- run state is `ok`
- the task has a real delivery mode and target
- the channel probe reports the target channel connected

Common signatures:

- `delivery.mode = none`
  - the task was only meant to run internally
- missing or invalid `channel` / `to`
  - the run can succeed while outbound delivery is skipped
- channel auth failures such as `unauthorized`, `missing_scope`, or `Forbidden`
  - credentials or channel permissions are blocking delivery

## Heartbeat feels silent

```bash
fased system heartbeat last
fased logs --follow
fased config get agents.defaults.heartbeat
fased channels status --probe
```

Healthy signs:

- heartbeat is enabled with a non-zero interval
- the last result is `ran`, or the skip reason makes sense

Common signatures:

- `reason=quiet-hours`
  - the current time is outside `activeHours`
- `requests-in-flight`
  - the main lane is busy and heartbeat deferred
- `empty-heartbeat-file`
  - `HEARTBEAT.md` had nothing actionable and no queued event needed attention
- `alerts-disabled`
  - the heartbeat ran, but outbound visibility settings suppressed the message

## Timezone and active-hours mistakes

```bash
fased config get agents.defaults.heartbeat.activeHours
fased config get agents.defaults.heartbeat.activeHours.timezone
fased config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
fased task list
fased logs --follow
```

Rules that matter:

- if `agents.defaults.userTimezone` is unset, heartbeat falls back to the host
  timezone unless `activeHours.timezone` is set explicitly
- task cron expressions without `--tz` use the gateway host timezone
- ISO timestamps without a timezone are treated as UTC for `at` schedules

Typical failure mode:

- tasks run at the wrong wall-clock hour after a host timezone change
- heartbeat stays quiet during your daytime because `activeHours.timezone` is
  wrong

## Related pages

- [Scheduled Tasks](/automation/cron-jobs)
- [Tasks vs Heartbeat](/automation/cron-vs-heartbeat)
- [Heartbeat](/gateway/heartbeat)
- [Timezone](/concepts/timezone)
