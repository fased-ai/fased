# Task UI Standard

Tasks use one interaction pattern across Agent Tasks, task overview/admin views,
Sessions, Chat, and source-owned activity records.

Agent > Tasks is the saved-work control surface. It should default to saved Task,
Trigger, Workflow, Graph, and Program definitions for the selected Agent. Run
history is audit data and should not fill an empty task list.

Domain pages still own domain control: Wallets approves/signs, Marketplace owns
order/review actions, Mining owns start/stop and cycle actions, Channels owns
routes/delivery, and media/service pages own their runtime setup.

For wallet, marketplace, and mining records, Agent > Tasks is view-only. It can
open the source page and start a review workflow, but the gateway rejects direct
retry/resume/control calls from Tasks so the authority surface remains Wallets,
Marketplace, or Mining.

## Layout

- Use a compact top strip for live counts, next wake time, refresh, and Create task.
- Use modal dialogs for Create task and Edit task. Do not place authoring forms beside or below the list.
- Use compact expandable rows for task lists.
- Keep the collapsed row to one line on desktop: task title, task id, schedule, state chips, and icon actions.
- Keep raw session keys, delivery details, runtime mode, model IDs, and run diagnostics inside the expanded row.
- Do not show prompt previews, delivery internals, or run diagnostics in the collapsed row.
- Key rows by task id so live refresh updates the row without collapsing expanded details or moving controls.

## Actions

- Create task opens the shared task modal.
- Edit opens the same modal with the task loaded.
- Run, Pause/Resume, Open chat/run, and Delete stay on the row action rail as icon buttons with clear hover text.
- Use one open action per row. Prefer the latest run transcript when it exists; otherwise open the task session.
- Domain-owned activity rows use source-specific open actions instead of pretending
  Tasks owns the operation: open Wallet approval, Marketplace order/review,
  Mining cycle/action, Channel session/delivery, Media handoff, or Webhook
  payload/replay when that action is safe.
- Wallet, marketplace, and mining rows are source-owned mirror records. Show
  review/open actions only; do not show direct approve, reject, retry, resume, or
  cancel controls from Agent Tasks.
- Workflow rows that were started from another activity record must show the source
  task and provide **Open source task** back to the original row/domain anchor.
- Delete should be a plain task action, not a browser confirm flow unless the operation is destructive beyond the task itself.

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

- Task lists should provide search, status, and date ordering.
- Agent > Tasks should provide filters for saved definitions first. Source
  filters for cron, webhook, subagent, channel, CLI, media, wallet, marketplace,
  and mining apply to run history, not the primary saved-definition count.
- Default sort is newest updated first.
- Agent Tasks must filter to the selected Agent.
- Task overview/admin views may include all Agents but must still use the same row and modal design.

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
