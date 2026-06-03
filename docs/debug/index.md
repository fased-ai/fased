---
title: "Debug"
summary: "Operator diagnostics for Advanced > Debug, Nodes, Logs, and Usage."
read_when:
  - You need to inspect runtime state after normal setup is complete
  - You are debugging provider, plugin, memory, node, log, or usage behavior
  - You need to know what belongs in Advanced instead of Agent setup
---

# Debug

Debug docs cover operator and admin diagnostics. They are not the normal setup
path for a new Agent. Start in **Agent > Models**, **Agent > Channels**,
**Agent > Skills**, **Agent > Tools**, **Agent > Memory**, **Agent > Services**,
and **Agent > Tasks** first. Use Debug when the friendly setup page says the
runtime state does not match saved config, when a plugin is not loaded, or when
you need raw evidence for support.

## Where to Look

| Surface | UI location           | Use it for                                                                                                                                                                               |
| ------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config  | **Advanced > Config** | Raw `~/.fased/fased.json` escape hatch for settings that do not yet have a focused page.                                                                                                 |
| Debug   | **Advanced > Debug**  | Ordered diagnostics, status/health/model snapshots, task/run diagnostics, provider catalog checks, plugin runtime diagnostics, memory repair preview, event log, and raw RPC inspection. |
| Nodes   | **Advanced > Nodes**  | Paired devices, node capabilities, runtime clients, exposed command counts, pending pairings, and command exposure checks.                                                               |
| Logs    | **Logs**              | Live gateway file logs, filters, auto-follow, export, and redacted operator troubleshooting.                                                                                             |
| Usage   | **Usage**             | Local model usage history by Agent, provider, model, session, task, channel/source, tokens, cache tokens, and priced/unpriced cost.                                                      |

Normal users should not need to open Advanced for first setup. If you are trying
to connect a model, channel, skill, service, wallet, or task, use the focused
Agent or runtime page instead.

## Common Workflows

**Gateway looks offline**

1. Check the top-bar health dot.
2. Open **Logs** and filter for startup, auth, provider, channel, or plugin
   errors.
3. Open **Advanced > Debug** only when you need the full status/health snapshots
   or raw RPC result.

**A channel, service, or skill says saved but not live**

1. Check the focused page first: **Agent > Channels**, **Agent > Services**, or
   **Agent > Skills**.
2. Check **Extensions** if the surface comes from a plugin.
3. Use **Advanced > Debug** for plugin runtime diagnostics, provider catalog
   checks, and raw status snapshots.

**A node or device is paired but cannot execute commands**

1. Open **Advanced > Nodes**.
2. Confirm the node is paired, recently connected, and advertising the expected
   capabilities.
3. Check the command exposure counts before changing exec or sandbox policy.

**Token usage looks wrong**

1. Open **Usage**.
2. Filter by Agent first, then provider/model/session/task/source.
3. Treat provider quota/account status separately from local token accounting.
   Local usage prefers transcript and task run-log usage records over session
   context snapshots.

**Memory diagnostics need repair**

1. Use **Agent > Memory** for the selected Agent's session-memory and QMD
   health.
2. Use **Advanced > Debug** for Memory Doctor repair preview and gated repair
   execution.
3. The preview is read-only. Repair execution requires the explicit admin path.

**A task appears stuck or missing from Agent > Tasks**

1. Open **Agent > Tasks** first and check the Task row and latest run.
2. Use cancel/retry from the row when the action is available.
3. Open **Advanced > Debug** for stale-running, lost-task, and queue
   reconciliation warnings.
4. Use **Logs** only when the run detail does not include enough failure detail.

## Boundaries

- **Debug is evidence, not setup.** If a friendly page exists, make the change
  there first.
- **Logs are redacted diagnostics.** Still review before sharing externally.
- **Nodes are device/runtime surfaces.** They are not normal chat channels.
- **Usage is local accounting.** Provider quota, billing portals, and OAuth
  account limits are separate.
- **Task/run diagnostics are local runtime evidence.** They are not full
  workflow orchestration; future Fased Workflows should build on stable run
  evidence.
- **Raw Config is the escape hatch.** Do not use it for routine Agent setup.

See also:

- [Dashboard](/web/dashboard)
- [Control UI](/web/control-ui)
- [Memory Doctor](/concepts/memory-doctor)
- [Nodes](/nodes/index)
- [Usage tracking](/concepts/usage-tracking)
- [Gateway logging](/gateway/logging)
