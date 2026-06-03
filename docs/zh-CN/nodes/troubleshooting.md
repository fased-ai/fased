---
summary: 节点故障排查：配对、前台要求、权限和工具调用失败。
read_when:
  - 节点已连接，但 camera/canvas/screen/exec 工具失败
  - 需要区分节点 pairing 和 exec approvals
title: 节点故障排查
---

# 节点故障排查

当节点在状态里可见，但节点工具失败时，用这个页面。

先在 Control UI 中检查：

1. 打开 **Advanced > Nodes**，确认节点已配对、已连接，并且广播了你要调用的能力。
2. 打开 **Logs**，过滤 `node`、`NODE_`、`camera`、`canvas`、`screen`、
   `location` 或 `SYSTEM_RUN_DENIED`。
3. 如果 Agent 不能使用一个健康的节点工具，检查该 Agent 的 **Agent > Tools** allow/deny policy。

## 命令阶梯

```bash
fased status
fased gateway status
fased logs --follow
fased doctor
```

然后运行节点检查：

```bash
fased nodes status
fased nodes describe --node <idOrNameOrIp>
fased approvals get --node <idOrNameOrIp>
```

健康信号：

- 节点已连接，并以 `node` 角色配对。
- `nodes describe` 包含你正在调用的 capability。
- Exec approvals 显示预期模式或 allowlist。
- **Advanced > Nodes** 中的 capability 和 last-seen 状态一致。

## 前台要求

iOS/Android 节点上的 `canvas.*`、`camera.*`、`screen.*` 通常要求 app 在前台。

```bash
fased nodes describe --node <idOrNameOrIp>
fased nodes canvas snapshot --node <idOrNameOrIp>
fased logs --follow
```

如果看到 `NODE_BACKGROUND_UNAVAILABLE`，把节点 app 切到前台后重试。

## 权限表

| Capability                   | iOS                           | Android                                | macOS node app                | 常见失败码                     |
| ---------------------------- | ----------------------------- | -------------------------------------- | ----------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Camera（clip audio 需要 mic） | Camera（clip audio 需要 mic）          | Camera（clip audio 需要 mic） | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Screen Recording（mic 可选）  | 系统 screen capture prompt（mic 可选） | Screen Recording              | `*_PERMISSION_REQUIRED`        |
| `location.get`               | While Using 或 Always         | Foreground/Background location         | Location permission           | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a                           | n/a                                    | Exec approvals                | `SYSTEM_RUN_DENIED`            |

## Pairing 与 approvals

这是两个不同的门：

1. **Device pairing**：节点是否能连接 Gateway？
2. **Exec approvals**：节点是否能运行某个 shell command？

```bash
fased devices list
fased nodes status
fased approvals get --node <idOrNameOrIp>
fased approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

如果 pairing 缺失，先批准 node device。
如果 pairing 正常但 `system.run` 失败，修复 exec approvals/allowlist。
如果二者都正常但 Agent 仍不能使用工具，检查该 Agent 的 **Agent > Tools**。

## 常见错误码

- `NODE_BACKGROUND_UNAVAILABLE`：app 在后台；切回前台。
- `CAMERA_DISABLED`：camera toggle 关闭。
- `*_PERMISSION_REQUIRED`：缺少 OS 权限。
- `LOCATION_DISABLED`：location mode 关闭。
- `LOCATION_PERMISSION_REQUIRED`：请求的位置模式未授权。
- `LOCATION_BACKGROUND_UNAVAILABLE`：app 在后台，但只有 While Using 权限。
- `SYSTEM_RUN_DENIED: approval required`：exec request 需要批准。
- `SYSTEM_RUN_DENIED: allowlist miss`：allowlist mode 阻止命令。

## 快速恢复循环

```bash
fased nodes status
fased nodes describe --node <idOrNameOrIp>
fased approvals get --node <idOrNameOrIp>
fased logs --follow
```

仍然卡住时：

- 重新批准 device pairing。
- 重新打开 node app 并保持前台。
- 重新授予 OS 权限。
- 调整 exec approval policy。

相关：

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
