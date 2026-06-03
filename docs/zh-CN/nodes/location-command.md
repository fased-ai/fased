---
read_when:
  - 添加位置节点支持或权限 UI
  - 排查 Agent 位置工具访问
summary: 节点的位置命令（location.get）、权限模式和 Agent 访问
title: 位置命令
x-i18n:
  generated_at: "2026-02-03T07:50:59Z"
  model: manual
  provider: pi
  source_hash: 23124096256384d2b28157352b072309c61c970a20e009aac5ce4a8250dc3764
  source_path: nodes/location-command.md
  workflow: 15
---

# 位置命令（节点）

## 简要概述

- `location.get` 是一个节点命令（通过 `node.invoke`）。
- 默认关闭。
- 设置使用选择器：关闭 / 使用时 / 始终。
- 单独的开关：精确位置。

## 为什么用选择器（而不只是开关）

操作系统权限是多级的。我们可以在应用内暴露选择器，但操作系统仍然决定实际授权。

- iOS/macOS：用户可以在系统提示/设置中选择**使用时**或**始终**。应用可以请求升级，但操作系统可能要求进入设置。
- Android：后台位置是单独的权限；在 Android 10+ 上通常需要进入设置流程。
- 精确位置是单独的授权（iOS 14+ "精确"，Android "精细" vs "粗略"）。

UI 中的选择器驱动我们请求的模式；实际授权存在于操作系统设置中。

## 设置模型

每个节点设备：

- `location.enabledMode`：`off | whileUsing | always`
- `location.preciseEnabled`：bool

UI 行为：

- 选择 `whileUsing` 请求前台权限。
- 选择 `always` 首先确保 `whileUsing`，然后请求后台（或在需要时将用户引导到设置）。
- 如果操作系统拒绝请求的级别，回退到已授予的最高级别并显示状态。

## 权限映射（node.permissions）

可选。macOS 节点通过权限映射报告 `location`；iOS/Android 可能省略它。

## 命令：`location.get`

通过 `node.invoke` 调用。

CLI 和节点工具使用的参数：

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

响应负载：

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

错误（稳定代码）：

- `LOCATION_DISABLED`：选择器已关闭。
- `LOCATION_PERMISSION_REQUIRED`：缺少请求模式的权限。
- `LOCATION_BACKGROUND_UNAVAILABLE`：应用在后台但只允许使用时。
- `LOCATION_TIMEOUT`：在时间内没有定位。
- `LOCATION_UNAVAILABLE`：系统故障/没有提供商。

## 模型/工具集成

- 工具接口：`nodes` 工具添加 `location_get` 操作（需要节点）。
- CLI：`fased nodes location get --node <id>`。
- 智能体指南：仅在用户启用位置并理解范围时调用。
