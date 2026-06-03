---
summary: "Choose between heartbeat and scheduled tasks for Fased automation"
read_when:
  - Deciding how a task should run on a schedule
  - Setting up background monitoring or periodic notifications
  - Tuning automation cost and delivery behavior
title: "Tasks vs Heartbeat"
---

# Tasks vs heartbeat

Fased gives you two scheduling patterns:

- **heartbeat** for periodic awareness inside the main session
- **Tasks** for exact schedules, reminders, and isolated runs

They overlap a little, but they are not the same tool.

Both patterns run under an Agent. Scheduled Tasks choose a main or isolated
session lane. A channel can receive the result, but the channel is only
delivery.
For no-model, skill-only, cheap-model, escalation, memory, and budget policy,
see [Task Operating Layer](/concepts/task-operating-layer).
For the Tasks v1 completion boundary, see [Tasks v1 Freeze](/concepts/tasks-v1-freeze).

## Quick decision guide

| Use case                                | Best fit            | Why                                     |
| --------------------------------------- | ------------------- | --------------------------------------- |
| Check inbox every 30 minutes            | Heartbeat           | batch it with other periodic checks     |
| Send a report at 9:00 AM sharp          | Task (isolated)     | exact timing matters                    |
| Watch the calendar for near-term events | Heartbeat           | context-aware and cheap to batch        |
| Run a weekly deep analysis              | Task (isolated)     | independent task, can use its own model |
| Remind me in 20 minutes                 | Task (main, `--at`) | one-shot precision                      |
| Background project health check         | Heartbeat           | better as part of ongoing awareness     |

## Heartbeat

Heartbeat runs in the **main session** on an interval, usually every 30 minutes.
It is best when the agent should periodically look around, decide what matters,
and stay context-aware.

### Use heartbeat when

- several periodic checks can be combined into one pass
- the task benefits from main-session memory and recent context
- you want natural suppression when nothing matters
- exact wall-clock timing is not important

### Heartbeat advantages

- batches inbox, calendar, notifications, and lightweight ops checks together
- reduces isolated agent turns and token churn
- has full main-session context
- can reply `HEARTBEAT_OK` and stay quiet when there is nothing to say

### Example `HEARTBEAT.md`

```md
# Heartbeat checklist

- Check email for anything urgent
- Review calendar events in the next two hours
- Surface any finished background work
- Send a check-in if the system has been quiet for a long time
```

### Example config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: { start: "08:00", end: "22:00" },
      },
    },
  },
}
```

See [Heartbeat](/gateway/heartbeat) for the full config surface.

## Tasks

Tasks run inside the gateway scheduler and store records under `~/.fased/cron/`
internally. They are the right choice when timing must be explicit or when the
work should run away from the main session.

In the UI, Chat **Schedule this**, Agent session task rows, and
`Agent > Tasks` all operate on the same scheduled Task records. The `/cron`
route is still routable for compatibility, but normal setup should start from
the selected Agent.

### Use tasks when

- the task must run at an exact time
- the run should be isolated from main-session history
- you want a different model or thinking level
- you need a one-shot reminder
- the task is frequent or noisy enough to avoid the main lane

### Task advantages

- exact `at`, `every`, and `cron` schedules
- timezone support
- isolated runs in `cron:<jobId>`
- per-task model and thinking overrides
- direct delivery via announce or webhook modes
- one-shot reminders with `--at`

### Example: daily briefing

```bash
fased task add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model openai/gpt-5.5 \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

### Example: one-shot reminder

```bash
fased task add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

See [Scheduled Tasks](/automation/cron-jobs) for the full reference.

## Fast rule of thumb

Use **heartbeat** when the question is:

- "should the agent periodically notice this?"

Use **tasks** when the question is:

- "must this happen at this time or as its own run?"

## Using both together

A good Fased setup usually combines them.

Heartbeat handles:

- inbox scans
- calendar awareness
- quiet-time check-ins
- lightweight background awareness

Tasks handle:

- daily briefings
- weekly reports
- one-shot reminders
- isolated heavy analysis

Example split:

**`HEARTBEAT.md`**

```md
# Heartbeat checklist

- Scan inbox for urgent mail
- Check calendar events in the next two hours
- Review any pending tasks
- Send a light check-in if the system has been quiet for a while
```

**Tasks**

```bash
fased task add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce
fased task add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model openai/gpt-5.5
fased task add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Main session vs isolated tasks

|                 | Heartbeat           | Task (main)               | Task (isolated)                                      |
| --------------- | ------------------- | ------------------------- | ---------------------------------------------------- |
| Runtime session | main                | main via system event     | `cron:<jobId>` run lane                              |
| Task owner      | Agent main session  | Agent/session on the task | Agent/session on the task                            |
| Context         | full                | full                      | clean run context                                    |
| History         | shared              | shared                    | separate run transcript, linked back by `sessionKey` |
| Model           | Agent/session model | Agent/session model       | overrideable                                         |
| Delivery        | heartbeat result    | main-session event        | announce/webhook/none                                |

### Use main-session tasks when

- the reminder should land inside existing context
- the next heartbeat should handle it as part of the main lane

### Use isolated tasks when

- you want a clean run
- you want different model/thinking settings
- you want direct delivery without adding chat clutter to the main lane

## Cost considerations

| Mechanism       | Cost profile                                                                 |
| --------------- | ---------------------------------------------------------------------------- |
| Heartbeat       | one turn every interval; cost scales with `HEARTBEAT.md` and attached checks |
| Task (main)     | small scheduled event; model cost only when it wakes or continues the lane   |
| Task (isolated) | full agent turn per run; best for explicit scheduled work                    |

Practical tips:

- keep `HEARTBEAT.md` compact
- batch related checks into heartbeat instead of many tiny scheduled tasks
- use isolated tasks for work that deserves its own model or its own delivery path

## Related

- [Heartbeat](/gateway/heartbeat)
- [Scheduled Tasks](/automation/cron-jobs)
- [System](/cli/system)
