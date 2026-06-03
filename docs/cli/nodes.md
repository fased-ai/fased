---
summary: "List, inspect, approve, and invoke paired nodes and their capabilities."
read_when:
  - You’re managing paired nodes (cameras, screen, canvas)
  - You need to approve requests or invoke node commands
title: "nodes"
---

# `fased nodes`

Manage paired nodes and invoke node capabilities such as command execution,
camera, screen, or image surfaces where available.

Browser equivalent: **Advanced > Nodes**. Nodes are optional device/runtime
peripherals, not normal first-run setup. Use **Agent > Tools** to decide whether
a selected Agent may use node-backed tools.

Related:

- Nodes overview: [Nodes](/nodes/index)
- Camera: [Camera nodes](/nodes/camera)
- Images: [Image nodes](/nodes/images)
- Diagnostics: [Diagnostics](/diagnostics/index)

Common options:

- `--url`, `--token`, `--timeout`, `--json`

## Common commands

```bash
fased nodes list
fased nodes list --connected
fased nodes list --last-connected 24h
fased nodes pending
fased nodes approve <requestId>
fased nodes reject <requestId>
fased nodes remove --node <id|name|ip>
fased nodes rename --node <id|name|ip> --name "Desk node"
fased nodes status
fased nodes status --connected
fased nodes status --last-connected 24h
fased nodes describe --node <id|name|ip>
fased nodes camera list --node <id|name|ip>
fased nodes camera snap --node <id|name|ip>
fased nodes screen record --node <id|name|ip> --duration 10s
fased nodes canvas snapshot --node <id|name|ip>
fased nodes location get --node <id|name|ip>
```

`nodes list` prints pending/paired tables. Paired rows include the most recent connect age (Last Connect).
Use `--connected` to only show currently-connected nodes. Use `--last-connected <duration>` to
filter to nodes that connected within a duration (e.g. `24h`, `7d`).

Pairing commands are top-level under `fased nodes`: `pending`, `approve`,
`reject`, `remove`, and `rename`.

## Invoke / run

```bash
fased nodes invoke --node <id|name|ip> --command <command> --params <json>
fased nodes run --node <id|name|ip> <command...>
fased nodes run --raw "git status"
fased nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke flags:

- `--params <json>`: JSON object string (default `{}`).
- `--invoke-timeout <ms>`: node invoke timeout (default `15000`).
- `--idempotency-key <key>`: optional idempotency key.

### Exec-style defaults

`nodes run` mirrors the model’s exec behavior (defaults + approvals):

- Reads `tools.exec.*` (plus `agents.list[].tools.exec.*` overrides).
- Uses exec approvals (`exec.approval.request`) before invoking `system.run`.
- `--node` can be omitted when `tools.exec.node` is set.
- Requires a node that advertises `system.run` (macOS companion app or headless node host).

Flags:

- `--cwd <path>`: working directory.
- `--env <key=val>`: env override (repeatable). Note: node hosts ignore `PATH` overrides (and `tools.exec.pathPrepend` is not applied to node hosts).
- `--command-timeout <ms>`: command timeout.
- `--invoke-timeout <ms>`: node invoke timeout (default `30000`).
- `--needs-screen-recording`: require screen recording permission.
- `--raw <command>`: run a shell string (`/bin/sh -lc` or `cmd.exe /c`).
  In allowlist mode on Windows node hosts, `cmd.exe /c` shell-wrapper runs require approval
  (allowlist entry alone does not auto-allow the wrapper form).
- `--agent <id>`: agent-scoped approvals/allowlists (defaults to configured agent).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: overrides.

## Media and device helpers

These commands invoke capabilities advertised by the selected node. Use
`fased nodes describe --node <id|name|ip>` first if you are unsure which
commands the node exposes.

```bash
fased nodes camera list --node <id|name|ip>
fased nodes camera snap --node <id|name|ip> --facing front
fased nodes camera clip --node <id|name|ip> --duration 10s --no-audio
fased nodes screen record --node <id|name|ip> --duration 10s --fps 10
fased nodes canvas present --node <id|name|ip> --target https://example.com
fased nodes canvas snapshot --node <id|name|ip> --format png
fased nodes canvas eval --node <id|name|ip> --js "document.title"
fased nodes location get --node <id|name|ip> --accuracy balanced
fased nodes notify --node <id|name|ip> --title "Ping" --body "Gateway ready"
fased nodes push --node <id|name|ip> --title "Ping" --body "Push test"
```

Media commands print `MEDIA:<path>` in text mode and return file metadata with
`--json`.
