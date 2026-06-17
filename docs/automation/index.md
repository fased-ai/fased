---
summary: "Beginner map for Fased automation: tasks, heartbeat, webhooks, hooks, Gmail, and polls."
read_when:
  - You want Fased to do work later or on a schedule
  - You are choosing between Tasks, heartbeat, hooks, or webhooks
title: "Automation"
---

# Automation

Automation is how Fased does work when you are not actively typing in Chat.

Use **Agent > Tasks** for saved work. Use domain pages for domain control:
Wallets approve and sign, Mining controls mining, Marketplace handles orders,
and Channels owns delivery routes.

```mermaid
flowchart TD
  UI["Agent UI"] --> Task["Task"]
  Chat["Chat or channel"] --> Task
  Webhook["Webhook trigger"] --> Trigger["Trigger"]
  Trigger --> Task
  Task --> Run["Run history"]
  Task --> Channel["Optional delivery"]
  Workflow["Workflow or Graph"] --> Run
  Domain["Wallet / Mining / Marketplace"] --> Run

  classDef primary fill:#1f2937,stroke:#ff8a65,color:#ffffff
  classDef secondary fill:#101827,stroke:#38bdf8,color:#ffffff
  class UI,Task,Run primary
  class Chat,Webhook,Trigger,Channel,Workflow,Domain secondary
```

## Choose the right surface

<Columns>
  <Card title="Task" href="/automation/cron-jobs" icon="calendar-clock">
    Run something later, once, or on a repeating schedule from Agent > Tasks.
  </Card>
  <Card title="Heartbeat" href="/automation/cron-vs-heartbeat" icon="activity">
    Keep periodic awareness in the main Agent session with `HEARTBEAT.md`.
  </Card>
  <Card title="Webhook trigger" href="/automation/webhook" icon="webhook">
    Let a trusted external system call Fased over authenticated HTTP.
  </Card>
  <Card title="Session memory hook" href="/automation/hooks" icon="hook">
    Save session context on reset/new chat from onboarding or Agent > Memory.
  </Card>
  <Card title="Gmail Pub/Sub" href="/automation/gmail-pubsub" icon="mail">
    Connect Gmail push notifications with `fased webhooks gmail setup`.
  </Card>
  <Card title="Poll" href="/automation/poll" icon="list-checks">
    Send a lightweight poll to a supported chat channel.
  </Card>
</Columns>

Most users should start with a Task.

## Beginner path

1. Open `http://localhost:18789/dash`.
2. Go to **Agents**.
3. Select the Agent that should own the work.
4. Open **Tasks**.
5. Create a Task, Trigger, Workflow, Graph, or Program.
6. Open the row's run history only when you need to inspect a run.

Useful CLI commands:

```bash
fased task list
fased task run <task-id>
fased task runs --id <task-id>
fased task run-show <run-id>
fased logs --follow
```

Use CLI when you are scripting, operating a headless host, or recovering a
broken setup.

## Definitions and history

Saved definitions are reusable setup:

- **Task**: scheduled or manually runnable Agent instruction
- **Trigger**: external event that starts work
- **Workflow**: linear checklist or approval flow
- **Graph**: branching workflow definition
- **Program**: standing order that proposes work for review
- **Template**: starter preset for a saved definition

Run history is what happened after something ran. It can record scheduled runs,
webhook fires, channel-triggered work, helper Agents, workflow nodes, wallet
approval mirrors, marketplace order records, mining events, media jobs, and
CLI/system actions.

Saved definitions and run history are separate. Editing a definition changes
future runs; old run records stay as audit history.

## What to create first

Create a **Task** when work needs a schedule, prompt, execution policy, memory
policy, skill limits, or delivery.

Create a **Trigger** when an outside system should call Fased over HTTP. A
trigger starts an Agent prompt, a saved workflow, a graph workflow, or a
heartbeat wake.

Create a **Workflow** for a short review or approval sequence. Use **Graph**
only when that sequence needs branches.

Use **Programs** for standing instructions that propose work for review.
Authority stays in the owning surface: Wallets, Marketplace, Mining, tools, and
services keep their own approval paths.

## Task templates

Fased ships starter Task templates for recurring work:

**Mining strategy review**

Review mining status, history, and strategy settings while funding, withdraw,
wallet send, start/stop, and bond controls stay unchanged.

**Mining status report**

Report running/stopped state, current cycle, wallet SOL/SAT, capital, locked
capital, claimable SAT, and blockers.

**Strategy A/B review**

Compare mining strategy modes while active commit settings stay unchanged.

**Wallet reserve watch**

Watch Agent, Vault, and Mining wallet fee reserves.

**Staking rewards watch**

Watch bond amount, claimable SAT, reward pool, and vault balance.

**Provider health check**

Check model providers, channels, tools, signer, and RPC readiness.

**Marketplace follow-up**

Surface open orders with payment, delivery, receipt, or review state.

**RPC pressure report**

Summarize RPC calls, pressure points, failover, and reduction targets.

Use a Task template when something runs on a schedule. Use a Workflow or Graph
when a human review sequence matters.

## Workflows and graphs

Workflows are small operator procedures. Supported step types include note,
checkpoint, wait, approval, handoff, and notify.

Graph workflows are the branching version of the same idea. The visual builder
edits the same graph JSON the runtime executes.

Workflows and graphs:

- write run history
- can pause on approval
- can link to source records
- keep script execution outside the workflow builder
- keep wallet, marketplace, mining, tool, and service authority in their owning
  surfaces

## Programs

A Program is an Agent-scoped standing order. It can write a blocked proposal
record for review. The operator decides whether to convert the proposal into a
real Task or Workflow.

Use Programs for durable intent and review.

## Security rules

- Keep webhook ingress private: localhost, Tailscale, or a trusted reverse
  proxy.
- Use a dedicated webhook token separate from your gateway owner token.
- Keep Agent ID routing fixed unless the trigger explicitly allows external
  routing.
- Keep session keys fixed or restricted to explicit prefixes.
- Installing or enabling a hook is code execution inside the gateway; use hook
  packs from sources you trust.

## Pages in this folder

- [Scheduled Tasks](/automation/cron-jobs)
- [Tasks vs Heartbeat](/automation/cron-vs-heartbeat)
- [Webhooks](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)
- [Hooks](/automation/hooks)
- [Polls](/automation/poll)
- [Auth Monitoring](/automation/auth-monitoring)
- [Troubleshooting](/automation/troubleshooting)
