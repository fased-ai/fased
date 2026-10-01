# Task UI Standard

Tasks use one interaction pattern across Agent Tasks, task overview/admin views,
Sessions, Chat, and source-owned activity records.

Agent > Tasks is the saved-work control surface. It should default to saved Task,
Trigger, Workflow, Graph, and Program definitions for the selected Agent. Run
history is audit data and should not fill an empty task list.

## Layout

- Use a compact top strip for live counts, next wake time, refresh, and Create task.
- Use modal dialogs for Create task and Edit task. Do not place authoring forms beside or below the list.
- Use compact expandable rows for task lists.
- Keep the collapsed row to one line on desktop: task title, task id, schedule, state chips, and icon actions.
- Keep raw session keys, delivery details, runtime mode, model IDs, and run diagnostics inside the expanded row.
- Do not show prompt previews, delivery internals, or run diagnostics in the collapsed row.
- Key rows by task id so live refresh updates the row without collapsing expanded details or moving controls.

## Actions

## Policy Presets

- Agent Tasks, task overview/admin views, Chat task dialogs, and channel task commands must
  expose the same task policy concepts.
- UI dialogs should provide the shared presets: Auto, Cheap check, Strong model,
  Skill-only, No model, and Stop on success.
- Presets only fill policy fields. Users can still edit schedule, prompt,
  delivery, model, skills, memory, budget, evaluator, and stop rules before
  saving.
- Channel commands can use natural language for the same choices, such as
  "use cheap check", "no model", "skill only", "escalate to `MODEL_REF`", or
  "stop after success".

## Filtering

## Data Freshness

- Create/edit/delete/run actions must refresh task state after the gateway mutation.
- External channel-created tasks must appear after task refresh or live task polling.
- Task overview/admin views should not show a permanent run-history panel at
  the bottom. Run details live in the expanded row and the open action links to
  the matching transcript when a session key exists.

## Naming

- Use **Task** in user-facing UI.
- Keep **Cron** only for internal APIs, storage, and low-level docs where the implementation mechanism matters.
- Use **Workflow** for simple or graph runs stored in task history and the flow
  registry.
- Do not call domain-owned records "scheduled tasks" unless they came from the
  scheduler. Use "activity record", "run history", or the source name instead.
