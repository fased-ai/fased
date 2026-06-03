---
summary: "Troubleshoot node pairing, foreground requirements, permissions, and tool failures"
read_when:
  - Node is connected but camera/canvas/screen/exec tools fail
  - You need the node pairing versus approvals mental model
title: "Node Troubleshooting"
---

# Node troubleshooting

Use this page when a node is visible in status but node tools fail.

Start in the Control UI:

1. Open **Advanced > Nodes** and confirm the node is paired, connected, and
   advertising the capability you are trying to use.
2. Open **Logs** and filter for `node`, `NODE_`, `camera`, `canvas`, `screen`,
   `location`, or `SYSTEM_RUN_DENIED`.
3. If an Agent cannot use an otherwise healthy node tool, check **Agent >
   Tools** for that selected Agent's allow/deny policy.

## Command ladder

```bash
fased status
fased gateway status
fased logs --follow
fased doctor
```

Then run node specific checks:

```bash
fased nodes status
fased nodes describe --node <idOrNameOrIp>
fased approvals get --node <idOrNameOrIp>
```

Healthy signals:

- Node is connected and paired for role `node`.
- `nodes describe` includes the capability you are calling.
- Exec approvals show expected mode/allowlist.
- **Advanced > Nodes** shows matching capability and last-seen state.

## Foreground requirements

`canvas.*`, `camera.*`, and `screen.*` are foreground only on iOS/Android nodes.

Quick check and fix:

```bash
fased nodes describe --node <idOrNameOrIp>
fased nodes canvas snapshot --node <idOrNameOrIp>
fased logs --follow
```

If you see `NODE_BACKGROUND_UNAVAILABLE`, bring the node app to the foreground and retry.

## Permissions matrix

| Capability                   | iOS                                     | Android                                      | macOS node app                | Typical failure code           |
| ---------------------------- | --------------------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Camera (+ mic for clip audio)           | Camera (+ mic for clip audio)                | Camera (+ mic for clip audio) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Screen Recording (+ mic optional)       | Screen capture prompt (+ mic optional)       | Screen Recording              | `*_PERMISSION_REQUIRED`        |
| `location.get`               | While Using or Always (depends on mode) | Foreground/Background location based on mode | Location permission           | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (node host path)                    | n/a (node host path)                         | Exec approvals required       | `SYSTEM_RUN_DENIED`            |

## Pairing versus approvals

These are different gates:

1. **Device pairing**: can this node connect to the gateway?
2. **Exec approvals**: can this node run a specific shell command?

Quick checks:

```bash
fased devices list
fased nodes status
fased approvals get --node <idOrNameOrIp>
fased approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

If pairing is missing, approve the node device first.
If pairing is fine but `system.run` fails, fix exec approvals/allowlist.
If both are fine but the Agent still cannot use the tool, fix **Agent > Tools**
for that Agent.

## Common node error codes

- `NODE_BACKGROUND_UNAVAILABLE` → app is backgrounded; bring it foreground.
- `CAMERA_DISABLED` → camera toggle disabled in node settings.
- `*_PERMISSION_REQUIRED` → OS permission missing/denied.
- `LOCATION_DISABLED` → location mode is off.
- `LOCATION_PERMISSION_REQUIRED` → requested location mode not granted.
- `LOCATION_BACKGROUND_UNAVAILABLE` → app is backgrounded but only While Using permission exists.
- `SYSTEM_RUN_DENIED: approval required` → exec request needs explicit approval.
- `SYSTEM_RUN_DENIED: allowlist miss` → command blocked by allowlist mode.
  On Windows node hosts, shell-wrapper forms like `cmd.exe /c ...` are treated as allowlist misses in
  allowlist mode unless approved via ask flow.

## Fast recovery loop

```bash
fased nodes status
fased nodes describe --node <idOrNameOrIp>
fased approvals get --node <idOrNameOrIp>
fased logs --follow
```

If still stuck:

- Re-approve device pairing.
- Re-open node app (foreground).
- Re-grant OS permissions.
- Recreate/adjust exec approval policy.

Related:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
