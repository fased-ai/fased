---
title: "Debug"
summary: "Advanced > Debug、Nodes、Logs 和 Usage 的运维诊断入口。"
read_when:
  - 普通设置完成后需要检查运行时状态
  - 调试 provider、plugin、memory、node、logs 或 usage 行为
---

# Debug

Debug 文档覆盖 operator/admin diagnostics。它不是新 Agent 的普通设置路径。连接模型、渠道、skills、tools、memory、services 或 tasks 时，先使用 **Agent > Models**、**Agent > Channels**、**Agent > Skills**、**Agent > Tools**、**Agent > Memory**、**Agent > Services** 和 **Agent > Tasks**。

## 去哪里看

| 页面   | UI 位置               | 用途                                                                                                                             |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Config | **Advanced > Config** | 原始 `~/.fased/fased.json` escape hatch。                                                                                        |
| Debug  | **Advanced > Debug**  | 有序诊断、status/health/model 快照、task/run 诊断、provider catalog、plugin runtime、memory repair preview、event log、raw RPC。 |
| Nodes  | **Advanced > Nodes**  | 已配对设备、node capabilities、runtime clients、pending pairings、command exposure。                                             |
| Logs   | **Logs**              | Gateway 日志、过滤、auto-follow、export。                                                                                        |
| Usage  | **Usage**             | 按 Agent、provider、model、session、task、channel/source 查看本地模型 usage history。                                            |

## 边界

- Debug 是证据，不是设置。能在友好页面完成的设置，先去友好页面。
- Logs 是已脱敏诊断，但对外分享前仍要审查。
- Nodes 是设备/runtime 表面，不是普通聊天渠道。
- Usage 是本地使用记录；provider quota/billing portal 是另一回事。
- Raw Config 是 escape hatch，不用于日常 Agent 设置。
