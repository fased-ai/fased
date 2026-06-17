---
summary: "Tasks v1 scope, proof gates, and the boundary between Tasks and older cron/heartbeat mechanics."
read_when:
  - Deciding whether the local Tasks runtime is complete enough to freeze
  - Comparing older cron/heartbeat behavior with Fased Tasks
title: "Tasks v1 Freeze"
---

# Tasks v1 Freeze

Tasks v1 is the first shippable local task runtime boundary for Fased Agents.

It does not mean the long-term adaptive Agent brain is finished. It means local
Task ownership, policy, queueing, recovery, and control surfaces have a clear
shape and a concrete proof gate.

The product rule is:

```text
Agent -> Session -> Task -> Trigger -> Policy -> Queue graph -> Delivery
```

Scheduler, cron, heartbeat, and worker leases are implementation mechanisms.
The user-facing object is a **Task**.

## Model Resolution

Task model selection is explicit and Agent-owned.

Resolution order:

1. Task explicit model or chat session override.
2. Agent task role for task-role runs.
3. Agent primary/fallback model for default Agent runs.
4. Provider-scoped migration fallback if no flat Agent field exists.
5. Global defaults.

Current config shape:

```ts
agents.list[].model?: string | {
  primary?: string
  fallbacks?: string[]
}
agents.list[].taskModels?: {
  cheapCheck?: string
  strong?: string
  escalation?: string
  coding?: string
  summarizer?: string
}
```

Provider credentials live in Agent auth profiles. Tasks must not hardwire
provider-specific fallback names.

## Local v1 Surface

The local v1 surface includes:

- scheduled tasks with `at`, `every`, and cron-expression triggers
- manual task runs from UI, CLI, WebChat, and connected channel commands
- Agent and Session ownership
- channel delivery without making the channel own the work
- Agent > Tasks plus task overview/admin views
- no-model, skill-only, agent-turn, cheap-check, and strong-model policies
- memory scope, skill scope, budget, escalation, and stop rules
- explicit Agent task-model roles
- deterministic or template-backed status/review paths where a concrete
  adapter is wired; wallet, mining, and marketplace authority remains on the
  owning surface
- preflight, needs-access state, and resume-after-setup flow
- run history, run transcript links, and run detail
- durable local queue items with worker leases
- cancel, retry, stale-lease recovery, and resumable checkpoints
- saved workflow definitions and graph workflow definitions with
  preview/run/resume handlers
- source metadata and repair state where a workflow/source adapter records them
- helper Agent or subagent evidence where the run explicitly records it under
  the same correlation chain
- adaptive next-run routing only after repeated-run evidence supports it

Tasks v1 is local to the gateway and local worker processes. Cross-node Fased
Network task rooms are a later layer.

## Not Part Of The Freeze

These are later task-runtime layers:

- cross-node distributed execution
- mid-call resume inside a provider/tool call
- longer-horizon learned routing
- richer semantic stop evaluation
- autonomous access/skill negotiation
- whole-workflow adaptation from repeated run evidence

Track these separately. They should not keep changing the local Task ownership
model.

## Completion Gate

Treat Tasks v1 as frozen only after these checks pass on a real local node:

1. Create a task from WebChat and see it in Agent > Tasks, overview/admin, and
   the owning Session.
2. Create a task from a connected channel and see the same Task in Agent >
   Tasks and `/task list`.
3. Run a no-model task and confirm no model call is used.
4. Run each shipped deterministic or template-backed status/review task and
   confirm it stays inside its selected skill/tool policy.
5. Run a cheap-check task with compact prompt, explicit cheap/check model
   selection, scoped memory, and bounded escalation.
6. Block a task on missing access, fix setup, and resume only after preflight
   passes.
7. Open run detail and confirm queue/run state, adapter/model/tool source,
   delivery result, evidence when present, and transcript link.
8. Cancel an active run, retry a failed run, and clear a stale lease.
9. Restart gateway or worker during a run and confirm recovery does not
   double-deliver.
10. For any shipped source-repair adapter, confirm the repaired graph does not
    loop forever.
11. For any shipped helper-Agent evidence path, confirm approval and selected
    Agent ids are recorded in run detail.
12. For any shipped adaptive routing path, run repeated Tasks and confirm
    `Adaptive next` appears only when recent history supports a route change.

If a proof fails, fix it before calling the task layer frozen.

## What Changed From Cron/Heartbeat

- Product object: older cron jobs, heartbeat wakes, and channel-triggered
  messages become Tasks owned by an Agent and Session.
- Ownership: Tasks carry explicit `agentId`, `sessionKey`, task id, trigger,
  policy, and delivery.
- Channel role: channels stay transport and optional delivery targets.
- Scheduling: triggers wake Tasks; task policy decides execution.
- Execution: a Task can run no-model, skill-only, model, or graph execution.
- Memory: memory scope is explicit per Task.
- Skills: skill scope and preflight are explicit.
- Recovery: queue status, leases, retry, checkpoint, and delivery replay are
  part of the task runtime.
- Evidence: run detail carries queue steps, source quality, adapters, delivery,
  transcript, and other proof.
- UI naming: user-facing UI says Task; `cron.*` remains internal storage.

The important change is moving work ownership away from scheduler mechanics and
into durable Agent/session Tasks.

## Memory And Skills In Tasks

Memory answers: what should this run remember or recall?

Skills answer: what capabilities may this run use?

A Task can use no memory, a compact session summary, pinned memory, memory
search, or broader Agent memory. It can expose no skills, selected skills, or
the Agent default tool set. Skill-only Tasks must name a deterministic action
and pass preflight before they run.

## Canonical Commands

Channel examples:

```text
/task new check provider health hourly
/task new every 15m Mining pulse: check mining status and send here
/task list
/task run <task-id>
/task last <task-id>
/task retry-run <run-id>
/task clear-stale <run-id>
```

CLI examples:

```bash
fased task list
fased task run <task-id>
fased task last <task-id>
fased task run-show <run-id>
fased task worker status
fased task smoke --repair
```

## Related Docs

- [Agents, Sessions, And Tasks](/concepts/agents-sessions-tasks)
- [Task Operating Layer](/concepts/task-operating-layer)
- [Task UI Standard](/concepts/task-ui-standard)
- [Scheduled Tasks](/automation/cron-jobs)
- [Tasks vs Heartbeat](/automation/cron-vs-heartbeat)
